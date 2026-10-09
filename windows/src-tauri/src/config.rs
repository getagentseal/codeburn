use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct CurrencyConfig {
    #[serde(default, flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

fn codeburn_config_dir() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".config/codeburn"))
        .unwrap_or_else(|| PathBuf::from(".codeburn"))
}

fn config_path() -> PathBuf {
    codeburn_config_dir().join("config.json")
}

impl CurrencyConfig {
    pub fn load_or_default() -> Self {
        match fs::read(config_path()) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn set_currency(&mut self, code: &str, symbol: &str) -> Result<()> {
        let disk = update(|obj| {
            if code == "USD" {
                obj.remove("currency");
            } else {
                obj.insert(
                    "currency".into(),
                    serde_json::json!({ "code": code, "symbol": symbol }),
                );
            }
        })?;
        *self = serde_json::from_value(serde_json::Value::Object(disk)).unwrap_or_default();
        Ok(())
    }
}

/// The whole config file, or an empty object when it is missing or unreadable. Read without
/// the lock on purpose: every writer renames a complete temporary file into place, so a
/// reader can never see a half-written file.
pub fn read() -> serde_json::Map<String, serde_json::Value> {
    fs::read(config_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

/// Read, mutate, rename: the one write path for every key this app shares with the CLI
/// (currency, `claudeConfigDirs`, the daily budget). The lock keeps two instances of this
/// app from dropping each other's edits; the rename keeps the file from ever being torn.
pub fn update(
    mutate: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>),
) -> Result<serde_json::Map<String, serde_json::Value>> {
    update_in(&codeburn_config_dir(), mutate)
}

fn update_in(
    dir: &Path,
    mutate: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>),
) -> Result<serde_json::Map<String, serde_json::Value>> {
    fs::create_dir_all(dir).with_context(|| "failed to create ~/.config/codeburn")?;

    #[cfg(unix)]
    let _lock = unix_lock::acquire(&dir.join(".config.lock"))?;
    #[cfg(windows)]
    let _lock = windows_lock::acquire(dir.join(".config.lock"))?;

    let path = dir.join("config.json");
    let mut disk = read_for_update(&path)?;
    mutate(&mut disk);

    let serialized = serde_json::to_vec_pretty(&disk)?;
    let tmp = path.with_extension("tmp");
    {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp)?;
        file.write_all(&serialized)?;
        file.flush()?;
    }
    fs::rename(&tmp, &path)?;
    Ok(disk)
}

/// Unlike `read`, a file that is there but unreadable or not a JSON object is an error: a
/// write built on an empty map would replace every key the user had.
fn read_for_update(path: &Path) -> Result<serde_json::Map<String, serde_json::Value>> {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(serde_json::Value::Object(map)) => Ok(map),
            _ => Err(anyhow!("~/.config/codeburn/config.json is not valid JSON; fix or remove it")),
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Map::new()),
        Err(err) => Err(err).with_context(|| "failed to read ~/.config/codeburn/config.json"),
    }
}

#[cfg(unix)]
mod unix_lock {
    use std::fs;
    use std::os::fd::AsRawFd;
    use anyhow::{anyhow, Context, Result};

    pub struct Guard {
        _file: fs::File,
    }

    pub fn acquire(path: &std::path::Path) -> Result<Guard> {
        let file = fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            // A lock file only ever needs to exist; its contents are irrelevant.
            .truncate(false)
            .open(path)
            .with_context(|| "failed to open config lock")?;

        let fd = file.as_raw_fd();
        let ret = unsafe { flock(fd, 2) };
        if ret != 0 {
            return Err(anyhow!("flock failed: {}", std::io::Error::last_os_error()));
        }
        Ok(Guard { _file: file })
    }

    extern "C" {
        fn flock(fd: i32, operation: i32) -> i32;
    }
}

/// Windows has no flock; a create-new lock file is the closest equivalent.
///
/// What this actually buys: mutual exclusion between writers that take this lock, which
/// today means only other instances of this app. The codeburn CLI writes `config.json`
/// without taking it, so a concurrent CLI write still races us -- the rename below keeps the
/// file from ever being torn, but a simultaneous CLI edit can still be the one that wins.
///
/// A lock file left behind by a crash is treated as abandoned once it is older than
/// STALE_LOCK_SECS (three orders of magnitude longer than the read-modify-rename it guards),
/// so one crash cannot wedge currency changes forever. Upgrading to `LockFileEx`, which the
/// OS releases on process death and needs no staleness heuristic, only becomes worth it if
/// the CLI ever starts taking the lock too.
#[cfg(windows)]
mod windows_lock {
    use std::fs;
    use std::path::PathBuf;
    use std::thread::sleep;
    use std::time::{Duration, SystemTime};
    use anyhow::{anyhow, Result};

    const RETRY_INTERVAL: Duration = Duration::from_millis(40);
    const MAX_RETRIES: u32 = 50;
    const STALE_LOCK_SECS: u64 = 30;

    pub struct Guard {
        path: PathBuf,
        /// Kept open for the lifetime of the guard: Windows will not unlink a file that is
        /// still open, so holding the handle is what stops the stale sweep below from ever
        /// deleting a lock whose owner is alive.
        file: Option<fs::File>,
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            self.file.take();
            let _ = fs::remove_file(&self.path);
        }
    }

    pub fn acquire(path: PathBuf) -> Result<Guard> {
        for _ in 0..MAX_RETRIES {
            match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => {
                    return Ok(Guard {
                        path,
                        file: Some(file),
                    })
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    // Only proceed on a successful unlink: a live holder still has the file
                    // open, so this fails for anything but an abandoned lock.
                    if is_stale(&path) && fs::remove_file(&path).is_ok() {
                        continue;
                    }
                    sleep(RETRY_INTERVAL);
                }
                Err(err) => return Err(anyhow!("failed to open config lock: {err}")),
            }
        }
        Err(anyhow!("config lock is held by another process"))
    }

    fn is_stale(path: &PathBuf) -> bool {
        fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .map(|age| age.as_secs() > STALE_LOCK_SECS)
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("codeburn-config-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn update_leaves_a_corrupt_config_untouched() {
        let dir = temp_dir("corrupt");
        for body in [&b"{ not json"[..], b"[1, 2]", b"null"] {
            fs::write(dir.join("config.json"), body).unwrap();
            let err = update_in(&dir, |obj| {
                obj.insert("cursorSync".into(), serde_json::Value::Bool(false));
            })
            .unwrap_err();
            assert!(err.to_string().contains("not valid JSON"), "{err}");
            assert_eq!(fs::read(dir.join("config.json")).unwrap(), body);
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_starts_fresh_without_a_config_and_keeps_other_keys() {
        let dir = temp_dir("fresh");
        update_in(&dir, |obj| {
            obj.insert("language".into(), serde_json::json!("fr"));
        })
        .unwrap();
        let disk = update_in(&dir, |obj| {
            obj.insert("cursorSync".into(), serde_json::Value::Bool(false));
        })
        .unwrap();
        assert_eq!(serde_json::Value::Object(disk), serde_json::json!({ "language": "fr", "cursorSync": false }));
        fs::remove_dir_all(&dir).unwrap();
    }
}
