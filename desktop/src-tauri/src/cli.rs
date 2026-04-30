use std::env;
use std::process::Stdio;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use tauri::AppHandle;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

/// Hard bounds mirror the macOS CodeburnCLI / DataClient design. A malicious or stuck CLI
/// cannot pin the Tauri process: stdout is capped, stderr is bounded, total wall time is
/// 60s. A hostile CODEBURN_BIN is rejected before any shell-resembling path is taken.
const MAX_PAYLOAD_BYTES: usize = 20 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 256 * 1024;
const FETCH_TIMEOUT_SECS: u64 = 60;

/// Alphanumerics plus `._/-` and space, with `\`, `:`, `(`, `)` also allowed on Windows
/// so a user-supplied `CODEBURN_BIN` path like `C:\Users\...\codeburn.cmd` is accepted.
/// None of these are shell metacharacters in a direct-argv spawn (we never invoke `sh -c`).
fn is_safe_arg(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '.' | '_' | '/' | '-' | ' ')
                || (cfg!(windows) && matches!(c, '\\' | ':' | '(' | ')'))
        })
}

#[derive(Clone, Debug)]
pub struct CodeburnCli {
    program: String,
    extra_args: Vec<String>,
}

impl CodeburnCli {
    /// Honours `CODEBURN_BIN` only when every whitespace-delimited token passes the
    /// allowlist. Otherwise falls back to resolving `codeburn` via PATH.
    pub fn resolve() -> Self {
        let raw = env::var("CODEBURN_BIN").unwrap_or_default();
        if raw.is_empty() {
            return Self::default_program();
        }
        let parts: Vec<String> = raw.split_whitespace().map(String::from).collect();
        if parts.iter().all(|p| is_safe_arg(p)) {
            if let Some((first, rest)) = parts.split_first() {
                return CodeburnCli {
                    program: first.clone(),
                    extra_args: rest.to_vec(),
                };
            }
        }
        eprintln!("codeburn-desktop: refusing unsafe CODEBURN_BIN; falling back to `codeburn`");
        Self::default_program()
    }

    fn default_program() -> Self {
        // npm installs `codeburn.cmd` on Windows; `std::process::Command` doesn't
        // guarantee PATHEXT resolution when the program name has no extension.
        #[cfg(windows)]
        let program = "codeburn.cmd".to_string();
        #[cfg(not(windows))]
        let program = "codeburn".to_string();
        CodeburnCli {
            program,
            extra_args: vec![],
        }
    }

    /// Spawns `codeburn status --format menubar-json --period X --provider Y` and decodes the
    /// output. Pipes are drained concurrently so a chatty stderr cannot deadlock stdout.
    pub async fn fetch_menubar_payload(
        &self,
        period: &str,
        provider: &str,
        include_optimize: bool,
    ) -> Result<Value> {
        if !is_safe_arg(period) || !is_safe_arg(provider) {
            bail!("invalid period/provider argument");
        }

        let mut args = self.extra_args.clone();
        args.extend(
            [
                "status",
                "--format",
                "menubar-json",
                "--period",
                period,
                "--provider",
                provider,
            ]
            .into_iter()
            .map(String::from),
        );
        if !include_optimize {
            args.push("--no-optimize".into());
        }

        let mut cmd = Command::new(&self.program);
        cmd.args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .with_context(|| format!("failed to spawn {}", self.program))?;

        let mut stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let mut stderr = child.stderr.take().ok_or_else(|| anyhow!("no stderr"))?;

        let stdout_task = tokio::spawn(async move {
            let mut buf = Vec::with_capacity(64 * 1024);
            let mut limited = (&mut stdout).take(MAX_PAYLOAD_BYTES as u64);
            limited.read_to_end(&mut buf).await.ok();
            buf
        });
        let stderr_task = tokio::spawn(async move {
            let mut buf = Vec::with_capacity(4 * 1024);
            let mut limited = (&mut stderr).take(MAX_STDERR_BYTES as u64);
            limited.read_to_end(&mut buf).await.ok();
            buf
        });

        let status = timeout(Duration::from_secs(FETCH_TIMEOUT_SECS), child.wait())
            .await
            .map_err(|_| anyhow!("codeburn CLI timed out after {}s", FETCH_TIMEOUT_SECS))??;

        let stdout_bytes = stdout_task.await.unwrap_or_default();
        let stderr_bytes = stderr_task.await.unwrap_or_default();

        if !status.success() {
            let msg = String::from_utf8_lossy(&stderr_bytes);
            bail!("codeburn CLI exited {}: {}", status, msg.trim());
        }

        let payload: Value = serde_json::from_slice(&stdout_bytes)
            .with_context(|| "CLI returned invalid JSON")?;
        Ok(payload)
    }
}

/// Runs a codeburn subcommand in the user's terminal emulator so they can see the output.
/// Linux: tries `x-terminal-emulator`, `gnome-terminal`, `konsole`, then falls back to a
/// detached headless spawn. Windows (later): opens cmd.exe. Never interpolates through a
/// shell -- argv throughout.
pub fn spawn_in_terminal(_app: &AppHandle, subcommand: &[&str]) -> Result<()> {
    if !subcommand.iter().all(|s| is_safe_arg(s)) {
        bail!("unsafe subcommand argument");
    }
    let cli = CodeburnCli::resolve();

    #[cfg(target_os = "linux")]
    {
        let terminals: [&[&str]; 4] = [
            &["x-terminal-emulator", "-e"],
            &["gnome-terminal", "--", "bash", "-lc"],
            &["konsole", "-e"],
            &["xterm", "-e"],
        ];
        for term in &terminals {
            let program = term[0];
            let extras = &term[1..];
            if which::which(program).is_ok() {
                let mut command_parts: Vec<String> = vec![cli.program.clone()];
                command_parts.extend(cli.extra_args.clone());
                command_parts.extend(subcommand.iter().map(|s| s.to_string()));
                // gnome-terminal wants the whole command as a single argv after `--`
                // followed by `bash -lc`. The allowlist guarantees no quoting is needed.
                let composite = command_parts.join(" ");
                let mut cmd = std::process::Command::new(program);
                cmd.args(extras);
                cmd.arg(&composite);
                cmd.spawn().with_context(|| format!("failed to launch {}", program))?;
                return Ok(());
            }
        }
        // Fallback: run detached, output lost -- better than silently doing nothing.
        std::process::Command::new(&cli.program)
            .args(&cli.extra_args)
            .args(subcommand)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| "no terminal emulator found, detached spawn also failed")?;
    }

    #[cfg(target_os = "windows")]
    {
        // `start` treats the first quoted argument as the window title, so we pass
        // an explicit empty title ("") to keep the program name from being eaten.
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/C").arg("start").arg("").arg(&cli.program);
        for a in &cli.extra_args { cmd.arg(a); }
        for a in subcommand { cmd.arg(a); }
        cmd.spawn().with_context(|| "failed to open cmd.exe")?;
    }

    #[cfg(target_os = "macos")]
    {
        // macOS isn't our target for this app (Swift handles Mac), but keep dev-on-Mac working.
        std::process::Command::new(&cli.program)
            .args(&cli.extra_args)
            .args(subcommand)
            .spawn()
            .with_context(|| format!("failed to spawn {}", cli.program))?;
    }

    Ok(())
}

/// Minimal dependency: we only use `which` inside spawn_in_terminal on Linux. Vendored here
/// so the crate graph stays tiny. Gated so the unused-function warning doesn't fire on Mac
/// or Windows builds.
#[cfg(target_os = "linux")]
mod which {
    use std::env;
    use std::path::PathBuf;

    pub fn which(program: &str) -> Result<PathBuf, ()> {
        let path = env::var_os("PATH").ok_or(())?;
        for dir in env::split_paths(&path) {
            let candidate = dir.join(program);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        Err(())
    }
}
