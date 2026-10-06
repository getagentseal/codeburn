//! Cheap change detection for the background usage refresh: if nothing the CLI reads has
//! been touched since the last successful payload, the tick that was about to spawn a Node
//! process can keep its money. Port of `mac/.../Data/UsageDataChangeGuard.swift` with the
//! Windows spellings of the roots, taken from the providers' own `probeRoots` in `src/`.
//!
//! Deliberately not a recursive session scan: a tick must not replace a full Node parse with
//! a full Rust walk of the same corpus. Directory mtimes move when an entry is added,
//! removed or renamed, which is what a new session or a new turn in a rolled file looks
//! like; a root that keeps everything in one file is watched as that file.
//!
//! The root list below tracks the CLI's provider discovery by hand, so a provider missing
//! from it must degrade to "refreshes every half hour", never to "stale forever". That is
//! what `MAX_SKIP_SECS` is for.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

/// Unchanged-skips are honoured for at most this long after the last successful fetch.
pub const MAX_SKIP_SECS: u64 = 30 * 60;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    /// Path to modification time in milliseconds. A path that does not exist is absent, so
    /// a root appearing or disappearing is itself a change.
    stamps: BTreeMap<String, u64>,
}

/// A watched location. `scan_children` adds the first level of directories below it, which
/// is where Claude and Codex put one directory per project or session; without it a new
/// session inside an existing project would not move anything this snapshot records.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Root {
    pub path: PathBuf,
    pub scan_children: bool,
}

fn dir(path: PathBuf) -> Root {
    Root {
        path,
        scan_children: true,
    }
}

fn leaf(path: PathBuf) -> Root {
    Root {
        path,
        scan_children: false,
    }
}

fn modified_ms(path: &Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|since| since.as_millis() as u64)
}

pub fn snapshot_of(roots: &[Root]) -> Snapshot {
    let mut stamps = BTreeMap::new();
    for root in roots {
        let key = root.path.to_string_lossy().to_string();
        if stamps.contains_key(&key) {
            continue;
        }
        let Some(stamp) = modified_ms(&root.path) else {
            continue;
        };
        stamps.insert(key, stamp);
        if !root.scan_children {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&root.path) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let child = entry.path();
            if let Some(stamp) = modified_ms(&child) {
                stamps.insert(child.to_string_lossy().to_string(), stamp);
            }
        }
    }
    Snapshot { stamps }
}

/// The pure half, so the arithmetic is testable without a filesystem: a background refresh
/// is skipped only when there is a successful anchor, it is younger than the ceiling, and
/// nothing under the watched roots has moved since.
pub fn should_skip(
    current: &Snapshot,
    last: Option<&Snapshot>,
    since_last_success: Option<Duration>,
) -> bool {
    let (Some(last), Some(elapsed)) = (last, since_last_success) else {
        return false;
    };
    if elapsed >= Duration::from_secs(MAX_SKIP_SECS) {
        return false;
    }
    current == last
}

static LAST_SUCCESS: Mutex<Option<(Snapshot, Instant)>> = Mutex::new(None);

/// Called when a payload fetch has come back. The anchor is taken after the answer, not
/// before it, so a fetch that failed can never make a later unchanged tick look successful.
pub fn record_success() {
    let taken = snapshot_of(&roots());
    if let Ok(mut guard) = LAST_SUCCESS.lock() {
        *guard = Some((taken, Instant::now()));
    }
}

/// Whether a background usage refresh would find the same corpus the last successful one
/// read. Only ever asked of a background tick: a refresh somebody asked for always runs.
pub fn unchanged_since_last_success() -> bool {
    let current = snapshot_of(&roots());
    let Ok(guard) = LAST_SUCCESS.lock() else {
        return false;
    };
    let (last, at) = match guard.as_ref() {
        Some(anchor) => (Some(&anchor.0), Some(anchor.1.elapsed())),
        None => (None, None),
    };
    should_skip(&current, last, at)
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|value| !value.as_os_str().is_empty())
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(target_os = "windows")]
fn app_data() -> PathBuf {
    env_path("APPDATA").unwrap_or_else(|| home().join("AppData").join("Roaming"))
}

#[cfg(target_os = "windows")]
fn local_app_data() -> PathBuf {
    env_path("LOCALAPPDATA").unwrap_or_else(|| home().join("AppData").join("Local"))
}

/// `XDG_DATA_HOME` or `~/.local/share`, which is what the CLI's cross-platform providers use
/// on Windows too: opencode, goose, kilo and zerostack never learned a Windows path.
fn xdg_data() -> PathBuf {
    env_path("XDG_DATA_HOME").unwrap_or_else(|| home().join(".local").join("share"))
}

fn xdg_config() -> PathBuf {
    env_path("XDG_CONFIG_HOME").unwrap_or_else(|| home().join(".config"))
}

/// The Claude config directories the CLI will read: the two environment overrides first
/// (`path.delimiter`-separated, which is `;` here), then what the settings window stored,
/// then the default.
fn claude_config_dirs() -> Vec<PathBuf> {
    if let Some(multi) = std::env::var_os("CLAUDE_CONFIG_DIRS") {
        let multi = multi.to_string_lossy().to_string();
        let dirs: Vec<PathBuf> = multi
            .split(if cfg!(windows) { ';' } else { ':' })
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(PathBuf::from)
            .collect();
        if !dirs.is_empty() {
            return dirs;
        }
    }
    if let Some(single) = env_path("CLAUDE_CONFIG_DIR") {
        return vec![single];
    }
    let stored = crate::settings::claude_config_dirs();
    if !stored.is_empty() {
        return stored.into_iter().map(PathBuf::from).collect();
    }
    vec![home().join(".claude")]
}

/// Splits AMP_DATA_DIR into its comma-separated roots (trimmed, empties dropped), matching
/// the Mac guard (UsageDataChangeGuard.swift) and the CLI's own `ampDataDirs` (amp.ts).
/// Falls back to `default` when the value is absent or has nothing usable left after that.
fn amp_data_dirs(value: Option<&str>, default: &Path) -> Vec<PathBuf> {
    let dirs: Vec<PathBuf> = value
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(PathBuf::from)
        .collect();
    if dirs.is_empty() {
        vec![default.to_path_buf()]
    } else {
        dirs
    }
}

/// The roots the CLI discovers sessions under, provider by provider. Every one of them is
/// either a directory whose entries change when a session is written, or the single file a
/// provider keeps its history in.
fn roots() -> Vec<Root> {
    let home = home();
    let mut roots: Vec<Root> = Vec::new();

    for config in claude_config_dirs() {
        roots.push(dir(config.join("projects")));
    }
    #[cfg(target_os = "windows")]
    roots.push(dir(env_path("CODEBURN_DESKTOP_SESSIONS_DIR").unwrap_or_else(|| {
        app_data().join("Claude").join("local-agent-mode-sessions")
    })));

    let codex = env_path("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
    roots.push(dir(codex.join("sessions")));
    roots.push(dir(codex.join("archived_sessions")));

    // Copilot: the CLI's own session store and state, plus the VS Code family, whose
    // workspaceStorage gains a directory per workspace and whose globalStorage holds the
    // chat sessions and the OTel traces database.
    let copilot = home.join(".copilot");
    roots.push(leaf(copilot.clone()));
    roots.push(leaf(copilot.join("session-state")));
    #[cfg(target_os = "windows")]
    {
        for flavour in ["Code", "Code - Insiders", "VSCodium"] {
            let user = app_data().join(flavour).join("User");
            roots.push(dir(user.join("workspaceStorage")));
            roots.push(leaf(
                user.join("globalStorage")
                    .join("github.copilot-chat")
                    .join("agent-traces.db"),
            ));
        }
        roots.push(leaf(local_app_data().join("github-copilot")));
        roots.push(leaf(xdg_config().join("github-copilot")));

        // Cursor keeps everything in one VS Code state database, with the workspace mapping
        // beside it; the agent CLI keeps its own project tree.
        let cursor = app_data().join("Cursor").join("User");
        roots.push(leaf(cursor.join("globalStorage").join("state.vscdb")));
        roots.push(dir(cursor.join("workspaceStorage")));

        roots.push(leaf(local_app_data().join("crush").join("projects.json")));
        roots.push(leaf(
            local_app_data().join("Zed").join("threads").join("threads.db"),
        ));
        roots.push(leaf(app_data().join("Open Design")));
        roots.push(leaf(
            app_data()
                .join("IBM Bob")
                .join("User")
                .join("globalStorage")
                .join("ibm.bob-code"),
        ));
        roots.push(leaf(
            app_data()
                .join("Kiro")
                .join("User")
                .join("globalStorage")
                .join("kiro.kiroagent"),
        ));
    }

    let cursor_agent = home.join(".cursor");
    roots.push(dir(cursor_agent.join("projects")));
    roots.push(leaf(
        cursor_agent
            .join("ai-tracking")
            .join("ai-code-tracking.db"),
    ));

    roots.push(leaf(home.join(".gemini").join("tmp")));
    for flavour in ["antigravity", "antigravity-cli", "antigravity-ide"] {
        roots.push(leaf(home.join(".gemini").join(flavour).join("conversations")));
        roots.push(leaf(home.join(".gemini").join(flavour).join("implicit")));
    }

    roots.push(leaf(home.join(".cline").join("data")));
    roots.push(leaf(home.join(".kiro")));
    roots.push(leaf(home.join(".mux")));
    roots.push(leaf(home.join(".lingtai")));
    roots.push(leaf(home.join(".lingtai-tui")));
    roots.push(leaf(home.join(".deepseek").join("sessions")));
    roots.push(leaf(home.join(".pi").join("agent").join("sessions")));
    roots.push(leaf(home.join(".omp").join("agent").join("sessions")));
    roots.push(leaf(home.join(".forge").join(".forge.db")));
    roots.push(leaf(home.join(".zcode").join("cli").join("db").join("db.sqlite")));
    for name in [".openclaw", ".clawdbot", ".moltbot", ".moldbot"] {
        roots.push(leaf(home.join(name).join("agents")));
    }
    roots.push(dir(
        env_path("CODEBURN_OPENCLAUDE_DIR")
            .unwrap_or_else(|| home.join(".openclaude"))
            .join("projects"),
    ));

    roots.push(leaf(
        env_path("CODEWHALE_HOME").unwrap_or_else(|| home.join(".codewhale")),
    ));
    roots.push(dir(
        env_path("DSH_HOME")
            .unwrap_or_else(|| home.join(".dsh"))
            .join("sessions"),
    ));
    roots.push(leaf(
        env_path("CODEBUFF_DATA_DIR").unwrap_or_else(|| xdg_config().join("manicode")),
    ));
    roots.push(leaf(
        env_path("FACTORY_DIR")
            .unwrap_or_else(|| home.join(".factory"))
            .join("sessions"),
    ));
    roots.push(leaf(
        env_path("HERMES_HOME").unwrap_or_else(|| home.join(".hermes")),
    ));
    roots.push(leaf(
        env_path("KIMI_SHARE_DIR")
            .unwrap_or_else(|| home.join(".kimi"))
            .join("sessions"),
    ));
    roots.push(leaf(
        env_path("VIBE_HOME")
            .unwrap_or_else(|| home.join(".vibe"))
            .join("logs")
            .join("session"),
    ));
    roots.push(leaf(
        env_path("GROK_HOME")
            .unwrap_or_else(|| home.join(".grok"))
            .join("sessions"),
    ));
    roots.push(leaf(
        env_path("QWEN_DATA_DIR").unwrap_or_else(|| home.join(".qwen").join("projects")),
    ));
    roots.push(leaf(
        env_path("OPENCODE_DATA_DIR").unwrap_or_else(|| xdg_data().join("opencode")),
    ));
    roots.push(leaf(
        env_path("GOOSE_PATH_ROOT").unwrap_or_else(|| xdg_data().join("goose")),
    ));
    roots.push(leaf(
        env_path("CRUSH_GLOBAL_DATA").unwrap_or_else(|| xdg_data().join("crush")),
    ));
    let amp_default = xdg_data().join("amp");
    let amp_value = std::env::var_os("AMP_DATA_DIR").map(|v| v.to_string_lossy().into_owned());
    for amp_dir in amp_data_dirs(amp_value.as_deref(), &amp_default) {
        roots.push(dir(amp_dir));
    }
    roots.push(leaf(
        env_path("ZS_DATA_DIR").unwrap_or_else(|| xdg_data().join("zerostack")),
    ));
    roots.push(leaf(xdg_data().join("kilo")));
    if let Some(warp) = env_path("WARP_DB_PATH") {
        roots.push(leaf(warp));
    }

    // A changed config can change the roots above, so its own mtime is part of the
    // fingerprint even when the directory list it names is the same.
    roots.push(leaf(home.join(".config").join("codeburn").join("config.json")));

    roots
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn snapshot_with(pairs: &[(&str, u64)]) -> Snapshot {
        Snapshot {
            stamps: pairs
                .iter()
                .map(|(path, stamp)| ((*path).to_string(), *stamp))
                .collect(),
        }
    }

    #[test]
    fn amp_data_dir_single_path() {
        let default = PathBuf::from("/default/amp");
        assert_eq!(
            amp_data_dirs(Some("/tmp/amp"), &default),
            vec![PathBuf::from("/tmp/amp")]
        );
    }

    #[test]
    fn amp_data_dir_comma_separated_paths() {
        let default = PathBuf::from("/default/amp");
        assert_eq!(
            amp_data_dirs(Some("/tmp/amp, /tmp/amp2"), &default),
            vec![PathBuf::from("/tmp/amp"), PathBuf::from("/tmp/amp2")]
        );
    }

    #[test]
    fn amp_data_dir_only_commas_and_spaces_falls_back_to_default() {
        let default = PathBuf::from("/default/amp");
        assert_eq!(amp_data_dirs(Some(" , , "), &default), vec![default]);
    }

    #[test]
    fn nothing_is_skipped_before_the_first_success() {
        let current = snapshot_with(&[("a", 1)]);
        assert!(!should_skip(&current, None, None));
        assert!(!should_skip(
            &current,
            Some(&snapshot_with(&[("a", 1)])),
            None
        ));
    }

    #[test]
    fn an_unchanged_corpus_is_skipped_inside_the_ceiling() {
        let current = snapshot_with(&[("a", 1), ("b", 2)]);
        let last = snapshot_with(&[("a", 1), ("b", 2)]);
        assert!(should_skip(
            &current,
            Some(&last),
            Some(Duration::from_secs(60))
        ));
    }

    #[test]
    fn a_moved_stamp_a_new_root_and_a_vanished_one_all_count_as_change() {
        let last = snapshot_with(&[("a", 1), ("b", 2)]);
        let elapsed = Some(Duration::from_secs(60));
        assert!(!should_skip(
            &snapshot_with(&[("a", 9), ("b", 2)]),
            Some(&last),
            elapsed
        ));
        assert!(!should_skip(
            &snapshot_with(&[("a", 1), ("b", 2), ("c", 3)]),
            Some(&last),
            elapsed
        ));
        assert!(!should_skip(
            &snapshot_with(&[("a", 1)]),
            Some(&last),
            elapsed
        ));
    }

    #[test]
    fn a_root_this_build_does_not_know_about_can_only_go_stale_for_half_an_hour() {
        let current = snapshot_with(&[("a", 1)]);
        let last = snapshot_with(&[("a", 1)]);
        assert!(should_skip(
            &current,
            Some(&last),
            Some(Duration::from_secs(MAX_SKIP_SECS - 1))
        ));
        assert!(!should_skip(
            &current,
            Some(&last),
            Some(Duration::from_secs(MAX_SKIP_SECS))
        ));
    }

    #[test]
    fn a_new_session_directory_moves_the_snapshot() {
        let base = std::env::temp_dir().join(format!(
            "codeburn-guard-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let projects = base.join("projects");
        std::fs::create_dir_all(projects.join("one")).unwrap();
        let roots = vec![dir(projects.clone()), leaf(base.join("missing.json"))];

        let before = snapshot_of(&roots);
        // The project directory and its one child; a path that does not exist contributes
        // nothing rather than a zero.
        assert_eq!(before.stamps.len(), 2);
        assert_eq!(snapshot_of(&roots), before);

        std::fs::create_dir_all(projects.join("two")).unwrap();
        let after = snapshot_of(&roots);
        assert_ne!(after, before);
        assert!(!should_skip(
            &after,
            Some(&before),
            Some(Duration::from_secs(1))
        ));

        std::fs::remove_dir_all(&base).ok();
    }
}
