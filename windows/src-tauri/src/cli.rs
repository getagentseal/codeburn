use std::env;
use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

/// Hard bounds mirror the macOS CodeburnCLI / DataClient design. A malicious or stuck CLI
/// cannot pin the Tauri process: stdout is capped, stderr is bounded, and a child that stops
/// talking is reaped. A hostile CODEBURN_BIN is rejected before any shell-resembling path is
/// taken.
const MAX_PAYLOAD_BYTES: usize = 20 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 256 * 1024;

/// The watchdog, ported from `mac/.../Data/CLIWatchdog.swift`. What is bounded is SILENCE,
/// not runtime: every byte the child writes on stdout or stderr restarts the clock. Read
/// spawns set `CODEBURN_PROGRESS=1`, under which the CLI's parser heartbeats every 10 s for
/// the whole of a parse (`PROGRESS_KEEPALIVE_MS` in `src/parser.ts`), so a legitimately slow
/// cold parse of a large corpus is never killed while a genuinely wedged child still is.
/// A flat wall-clock timeout could only ever be one of those two things.
///
/// Silence a live child cannot produce: 4.5x the CLI's keepalive cadence.
const SILENCE_SECS: u64 = 45;
/// Until one payload has come back, the on-disk session cache may be empty and a full
/// hydration has genuinely silent stretches before the first keepalive is armed. Finite on
/// purpose: a child that never emits a byte still dies here, it just gets the cold budget to
/// prove itself first.
const COLD_SILENCE_SECS: u64 = 10 * 60;
/// Backstop: a livelocked child that chatters forever without finishing is still reaped.
const CEILING_SECS: u64 = 15 * 60;
/// A stop request is asked for first, so the CLI can unlink its own refresh lock; only a
/// child that ignores it is killed.
const KILL_GRACE_SECS: u64 = 5;
/// A `--version` probe that says nothing for this long is not slow, it is broken, and the
/// setup screen is waiting on it.
const VERSION_SILENCE_SECS: u64 = 20;

/// Wire marker for the CLI's scan-progress lines (`PROGRESS_LINE_PREFIX`, `src/parser.ts`).
/// They share stderr with real diagnostics, so they must never become the error message.
const PROGRESS_LINE_PREFIX: &str = "CODEBURN_PROGRESS ";

/// Set once a payload has come back, which is what lifts the cold silence budget. Process
/// wide, as the mac's is: the corpus is the same for every window asking.
static PAYLOAD_SEEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The silence window for a request: the cold floor applies until this app has completed one
/// payload, exactly as the mac floors every request admitted before its client is warm.
fn silence_window(warm: bool) -> u64 {
    if warm {
        SILENCE_SECS
    } else {
        SILENCE_SECS.max(COLD_SILENCE_SECS)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Verdict {
    Wait,
    Silent,
    Ceiling,
}

/// Pure so the arithmetic is testable without spawning a child and waiting minutes for a
/// real ceiling. All three arguments are seconds on one monotonic scale.
fn verdict(since_start: f64, since_output: f64, silence_secs: f64) -> Verdict {
    if since_output >= silence_secs {
        return Verdict::Silent;
    }
    if since_start >= CEILING_SECS as f64 {
        return Verdict::Ceiling;
    }
    Verdict::Wait
}

fn without_progress_lines(stderr: &str) -> String {
    stderr
        .lines()
        .filter(|line| !line.starts_with(PROGRESS_LINE_PREFIX))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// Oldest CLI this app can talk to. 0.9.9 is the first release whose
/// `status --format menubar-json` accepts `--no-optimize`, which every quiet background
/// refresh passes; it also emits all the payload fields the popover reads
/// (`current.providers`, `current.cacheHitPercent`, `history.daily[].topModels`). Older CLIs
/// get the setup screen instead of a half-rendered popover or a stream of spawn failures.
pub const MIN_CLI_VERSION: (u32, u32, u32) = (0, 9, 9);

#[cfg(windows)]
const WINDOWS_CLI_NAMES: [&str; 2] = ["codeburn.cmd", "codeburn.exe"];

#[cfg(windows)]
const CLAUDE_NAMES: [&str; 2] = ["claude.cmd", "claude.exe"];
#[cfg(not(windows))]
const CLAUDE_NAMES: [&str; 1] = ["claude"];

/// Alphanumerics plus `._/-` and space, with `\`, `:`, `(`, `)` also allowed on Windows
/// so a user-supplied `CODEBURN_BIN` path like `C:\Users\...\codeburn.cmd` is accepted.
/// None of these are shell metacharacters in a direct-argv spawn (we never invoke `sh -c`).
/// `YYYY-MM-DD` and nothing else, which is what `--day` and `--days` accept.
fn is_iso_day(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
}

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

/// What the setup screen needs to know about the CLI on this machine.
#[derive(Clone, Debug, Serialize)]
pub struct CliStatus {
    pub found: bool,
    pub program: String,
    pub version: Option<String>,
    pub min_version: String,
    pub compatible: bool,
    pub error: Option<String>,
}

/// What the Capacity Dock renders: the provider array, or the reason there isn't one.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum DockQuota {
    Ready { providers: Value },
    CliOutdated,
    Unavailable { message: String },
}

impl CodeburnCli {
    /// Honours `CODEBURN_BIN` only when every whitespace-delimited token passes the
    /// allowlist. Otherwise resolves `codeburn` from PATH and the usual npm locations.
    pub fn resolve() -> Self {
        let raw = env::var("CODEBURN_BIN").unwrap_or_default();
        if raw.is_empty() {
            return Self::default_program();
        }
        // A bare path (which may contain spaces, e.g. under Program Files) is used whole;
        // only otherwise is the value split into program + leading arguments.
        if is_safe_arg(&raw) && std::path::Path::new(&raw).is_file() {
            return CodeburnCli {
                program: raw,
                extra_args: vec![],
            };
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
        crate::log_line!("codeburn-menubar: refusing unsafe CODEBURN_BIN; falling back to `codeburn`");
        Self::default_program()
    }

    /// PATH and the usual install prefixes first, then the CLI the CodeBurn desktop app
    /// leaves behind, so a global `codeburn` still wins wherever there is one.
    fn default_program() -> Self {
        CodeburnCli {
            program: locate_cli()
                .or_else(recorded_desktop_cli)
                .unwrap_or_else(default_program_name),
            extra_args: vec![],
        }
    }

    pub fn program(&self) -> &str {
        &self.program
    }

    /// The program plus the arguments every call carries. For a caller that builds its own
    /// spawn: the update stages need the exit code and the stderr separately rather than the
    /// captured stdout `run_capture` returns.
    pub fn argv(&self) -> Vec<String> {
        let mut argv = vec![self.program.clone()];
        argv.extend(self.extra_args.iter().cloned());
        argv
    }

    /// Runs `codeburn --version` and reports whether the CLI is present and new enough.
    pub async fn status(&self) -> CliStatus {
        let min_version = format!(
            "{}.{}.{}",
            MIN_CLI_VERSION.0, MIN_CLI_VERSION.1, MIN_CLI_VERSION.2
        );
        let mut status = CliStatus {
            found: false,
            program: self.program.clone(),
            version: None,
            min_version,
            compatible: false,
            error: None,
        };
        match self.run_capture(&["--version"], VERSION_SILENCE_SECS).await {
            Ok(out) => {
                let version = out.trim().to_string();
                status.found = true;
                status.compatible = parse_version(&version)
                    .map(|v| v >= MIN_CLI_VERSION)
                    .unwrap_or(false);
                status.version = Some(version);
            }
            Err(err) => {
                status.error = Some(err.to_string());
            }
        }
        status
    }

    /// Spawns `codeburn status --format menubar-json --period X --provider Y` and decodes the
    /// output. Pipes are drained concurrently so a chatty stderr cannot deadlock stdout.
    pub async fn fetch_menubar_payload(
        &self,
        period: &str,
        provider: &str,
        days: &[String],
        scope: &str,
        claude_config_source: Option<&str>,
        include_optimize: bool,
    ) -> Result<Value> {
        if !is_safe_arg(period) || !is_safe_arg(provider) || !is_safe_arg(scope) {
            bail!("invalid period/provider/scope argument");
        }
        if !days.iter().all(|d| is_iso_day(d)) {
            bail!("invalid day argument");
        }
        if claude_config_source.is_some_and(|id| !is_safe_arg(id)) {
            bail!("invalid claude config argument");
        }

        // A picked day overrides the period, so the CLI gets one or the other, never
        // both kinds of range. `--day` is the single-day form; `--days` takes a
        // comma-separated list.
        let joined = days.join(",");
        let mut args = vec![
            "status",
            "--format",
            "menubar-json",
            "--provider",
            provider,
            "--scope",
            scope,
        ];
        match days.len() {
            0 => args.extend(["--period", period]),
            1 => args.extend(["--day", joined.as_str()]),
            _ => args.extend(["--days", joined.as_str()]),
        }
        // The CLI rejects a config source alongside combined scope, since a Claude
        // config scopes Claude usage on this machine only. The page never sends both.
        if let Some(id) = claude_config_source {
            args.extend(["--claude-config-source", id]);
        }
        if !include_optimize {
            args.push("--no-optimize");
        }

        // Cold, the session cache can be empty and a full hydration has silent stretches
        // before the first keepalive; warm, 45 s of silence is a wedged child.
        let warm = PAYLOAD_SEEN.load(std::sync::atomic::Ordering::Relaxed);
        let stdout = self.run_capture(&args, silence_window(warm)).await?;
        let payload: Value =
            serde_json::from_str(&stdout).with_context(|| "CLI returned invalid JSON")?;
        PAYLOAD_SEEN.store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(payload)
    }

    /// Spawns `codeburn quota --format json` for the Capacity Dock. A CLI without the
    /// subcommand exits 1 with `unknown command`, which the dock reports as a quiet
    /// "CLI update needed" state rather than an error.
    ///
    /// Provider keys pasted into the settings window ride along as environment variables on
    /// the child, which is the only credential channel the CLI has. They are never put on a
    /// command line and never logged.
    pub async fn fetch_quota(&self) -> DockQuota {
        let stdout = match self
            .run_capture_with_env(
                &["quota", "--format", "json"],
                SILENCE_SECS,
                &crate::settings::quota_environment(),
            )
            .await
        {
            Ok(stdout) => stdout,
            Err(err) => {
                let message = err.to_string();
                return if message.contains("unknown command") {
                    DockQuota::CliOutdated
                } else {
                    DockQuota::Unavailable { message }
                };
            }
        };

        match serde_json::from_str::<Value>(&stdout) {
            Ok(payload) => DockQuota::Ready {
                providers: payload
                    .get("providers")
                    .cloned()
                    .unwrap_or_else(|| Value::Array(vec![])),
            },
            Err(err) => DockQuota::Unavailable {
                message: format!("CLI returned invalid JSON: {err}"),
            },
        }
    }

    /// `codeburn export -f <format> -o <path>`, the mac's `runExport`. The path is built by
    /// `commands::export_usage` rather than supplied by the reader, so it is not put through
    /// the argument allowlist, which would reject a drive letter and a backslash. Nothing is
    /// interpolated through a shell: this is argv, as every other spawn here is.
    pub async fn export_to(&self, format: &str, output: &std::path::Path) -> Result<()> {
        if !matches!(format, "csv" | "json") {
            bail!("unknown export format");
        }
        let path = output.to_string_lossy().to_string();
        let warm = PAYLOAD_SEEN.load(std::sync::atomic::Ordering::Relaxed);
        self.run_capture(&["export", "-f", format, "-o", &path], silence_window(warm))
            .await?;
        Ok(())
    }

    async fn run_capture(&self, args: &[&str], silence_secs: u64) -> Result<String> {
        self.run_capture_with_env(args, silence_secs, &[]).await
    }

    /// Spawns the CLI and drains both pipes, watching for silence rather than for elapsed
    /// time. `silence_secs` is how long the child may say nothing before it is stopped.
    async fn run_capture_with_env(
        &self,
        args: &[&str],
        silence_secs: u64,
        env: &[(String, String)],
    ) -> Result<String> {
        let mut full_args = self.extra_args.clone();
        full_args.extend(args.iter().map(|s| s.to_string()));

        let mut cmd = Command::new(&self.program);
        cmd.args(&full_args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // The heartbeat that gives a silence window its meaning: under this the CLI's
            // parser writes a keepalive line every 10 s for the whole of a scan.
            .env("CODEBURN_PROGRESS", "1")
            .kill_on_drop(true);
        for (name, value) in env {
            cmd.env(name, value);
        }
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            // Its own process group, so the stop request below reaches the child and what it
            // spawned, and nothing else.
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
            cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        }
        let mut child = cmd
            .spawn()
            .map_err(|err| anyhow!("{}", spawn_failure_message(&self.program, &err)))?;

        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| anyhow!("no stderr"))?;

        // One monotonic marker shared by the two drain tasks and the watchdog below. Every
        // byte either pipe produces restarts the clock, which is the whole point: what is
        // bounded is silence, not work.
        let activity = std::sync::Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
        let stdout_task = tokio::spawn(drain(stdout, MAX_PAYLOAD_BYTES, activity.clone()));
        let stderr_task = tokio::spawn(drain(stderr, MAX_STDERR_BYTES, activity.clone()));

        let started = std::time::Instant::now();
        let status = loop {
            tokio::select! {
                finished = child.wait() => break finished?,
                _ = tokio::time::sleep(Duration::from_millis(500)) => {
                    let quiet = activity
                        .lock()
                        .map(|at| at.elapsed().as_secs_f64())
                        .unwrap_or(0.0);
                    match verdict(started.elapsed().as_secs_f64(), quiet, silence_secs as f64) {
                        Verdict::Wait => continue,
                        Verdict::Silent => {
                            stop_child(&mut child).await;
                            bail!(
                                "codeburn CLI produced no output for {}s and was stopped",
                                silence_secs
                            );
                        }
                        Verdict::Ceiling => {
                            stop_child(&mut child).await;
                            bail!(
                                "codeburn CLI ran for {}s without finishing and was stopped",
                                CEILING_SECS
                            );
                        }
                    }
                }
            }
        };

        let stdout_bytes = stdout_task.await.unwrap_or_default();
        let stderr_bytes = stderr_task.await.unwrap_or_default();

        if !status.success() {
            let msg = without_progress_lines(&String::from_utf8_lossy(&stderr_bytes));
            bail!("codeburn CLI exited {}: {}", status, msg);
        }
        Ok(String::from_utf8_lossy(&stdout_bytes).into_owned())
    }
}

/// Reads until the pipe closes, capping what is kept and touching the activity marker on
/// every chunk. Reading in chunks rather than to the end is what makes the marker possible.
async fn drain<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
    mut pipe: R,
    cap: usize,
    activity: std::sync::Arc<std::sync::Mutex<std::time::Instant>>,
) -> Vec<u8> {
    let mut kept: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut chunk = vec![0u8; 32 * 1024];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if let Ok(mut at) = activity.lock() {
                    *at = std::time::Instant::now();
                }
                if kept.len() < cap {
                    let room = cap - kept.len();
                    kept.extend_from_slice(&chunk[..read.min(room)]);
                }
            }
        }
    }
    kept
}

/// Ask, then insist. The CLI unlinks its own refresh lock when it is asked to stop
/// (`armSignalCleanup` in `src/session-cache.ts`), so a child that can be asked is asked
/// first and only one that ignores the request inside the grace is killed.
async fn stop_child(child: &mut tokio::process::Child) {
    let Some(pid) = child.id() else {
        let _ = child.kill().await;
        return;
    };
    let asked = request_stop(pid);
    if asked {
        if let Ok(Ok(_)) = timeout(Duration::from_secs(KILL_GRACE_SECS), child.wait()).await {
            #[cfg(debug_assertions)]
            crate::log_line!("codeburn: silent CLI child {pid} stopped on request");
            return;
        }
    }
    kill_tree(pid);
    let _ = child.kill().await;
    #[cfg(debug_assertions)]
    crate::log_line!("codeburn: silent CLI child {pid} killed (stop request accepted: {asked})");
}

/// What this app spawns on Windows is `codeburn.cmd`, so the process that does the work is
/// node, a generation below. Killing the handle we hold ends the shim and orphans the parse,
/// which is the opposite of the point, and there is no process group to end in one call once
/// the console request has been refused. `taskkill /T` is the tool Windows gives for that;
/// the same System32-anchored spawn the PATH lookup already uses.
#[cfg(windows)]
fn kill_tree(pid: u32) {
    let _ = system_command("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(windows))]
fn kill_tree(_pid: u32) {}

/// Ctrl+Break to the child's own process group, which is what a console process on Windows
/// has instead of SIGTERM: node delivers it as SIGBREAK, which the CLI's cleanup handler
/// runs on. The child's console has to be borrowed to send it, so a handler of our own is
/// installed for the moment that takes, and the lock keeps two watchdogs from borrowing at
/// once.
///
/// A process may own only one console, so this is refused in a debug build, which is a
/// console subsystem app and already has one. The shipped build has none and can borrow;
/// either way a child that is not stopped is killed, tree and all, a few seconds later.
#[cfg(windows)]
fn request_stop(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::BOOL;
    use windows_sys::Win32::System::Console::{
        AttachConsole, FreeConsole, GenerateConsoleCtrlEvent, SetConsoleCtrlHandler,
        CTRL_BREAK_EVENT,
    };

    static CONSOLE: std::sync::Mutex<()> = std::sync::Mutex::new(());

    unsafe extern "system" fn swallow(_event: u32) -> BOOL {
        1
    }

    let Ok(_borrowed) = CONSOLE.lock() else {
        return false;
    };
    unsafe {
        if AttachConsole(pid) == 0 {
            return false;
        }
        SetConsoleCtrlHandler(Some(swallow), 1);
        let sent = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid) != 0;
        FreeConsole();
        SetConsoleCtrlHandler(Some(swallow), 0);
        sent
    }
}

/// There is no SIGTERM here without a libc dependency this app does not otherwise need, so
/// the Linux build goes straight to the kill; the CLI's lock has its own staleness timeout
/// for that case.
#[cfg(not(windows))]
fn request_stop(_pid: u32) -> bool {
    false
}

fn spawn_error_summary(program: &str, err: &std::io::Error) -> String {
    match err.kind() {
        std::io::ErrorKind::NotFound => format!("{} is not on PATH", program),
        _ => format!("{}: {}", program, err),
    }
}

/// What a failed spawn tells the setup screen. A program still named `codeburn.cmd` is one
/// nothing resolved: not PATH, not the npm and node prefixes, and not the desktop app's
/// recorded launcher either. Saying it is "not on PATH" would name one of the two ways to
/// have a CLI and leave out the other, so that case says both.
fn spawn_failure_message(program: &str, err: &std::io::Error) -> String {
    if program == default_program_name() && err.kind() == std::io::ErrorKind::NotFound {
        return "No CodeBurn CLI found: nothing on PATH, and no CodeBurn desktop app to \
                borrow one from. Install the desktop app, or run `npm install -g codeburn`."
            .to_string();
    }
    format!(
        "CodeBurn CLI not found ({}). Install it with `npm install -g codeburn`.",
        spawn_error_summary(program, err)
    )
}

fn default_program_name() -> String {
    #[cfg(windows)]
    {
        "codeburn.cmd".to_string()
    }
    #[cfg(not(windows))]
    {
        "codeburn".to_string()
    }
}

/// Parses "0.7.3" or "codeburn 0.7.3" into a comparable tuple.
pub fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    let token = text
        .split_whitespace()
        .find(|t| t.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false))?;
    let mut parts = token.split('.').map(|p| {
        p.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u32>()
            .ok()
    });
    Some((parts.next()??, parts.next()??, parts.next().flatten().unwrap_or(0)))
}

/// Locates the CLI without relying on the inherited PATH being fresh. A tray app is often
/// launched from Explorer or at login, before (or long after) `npm install -g codeburn`
/// changed the user's PATH, so we also read the live PATH from the registry on Windows and
/// probe the standard npm / node install prefixes.
fn locate_cli() -> Option<String> {
    find_in_search_dirs(&candidate_names())
}

/// Same search for Claude Code's own binary, so "Connect Claude" spawns an absolute path
/// instead of letting the console shell resolve a bare `claude`.
fn locate_claude() -> Option<String> {
    find_in_search_dirs(&CLAUDE_NAMES)
}

/// The key the CodeBurn desktop app writes into `windows-settings.json` (the same file this
/// app keeps its own preferences in, app/electron/menubar.ts). Its value is a `.cmd` the
/// desktop app generates, which runs the CLI copy shipped inside the desktop app through the
/// desktop app's own executable. On a machine where someone installed the desktop app and
/// never ran `npm install -g codeburn`, that is the only CLI there is.
#[cfg(windows)]
const DESKTOP_CLI_KEY: &str = "desktopCliPath";

/// The recorded launcher, or nothing. Last in the search on purpose: a real global install is
/// what the user chose, and the desktop app's copy is what a machine has when nobody chose.
#[cfg(windows)]
fn recorded_desktop_cli() -> Option<String> {
    let path = recorded_cli_candidate(&crate::settings::read())?;
    std::path::Path::new(&path).is_file().then_some(path)
}

#[cfg(not(windows))]
fn recorded_desktop_cli() -> Option<String> {
    None
}

/// The shape check, apart from the disk check so it can be tested without one. A resolved
/// program reaches a console command line through `spawn_program_in_terminal`, so a recorded
/// path passes the same allowlist a `CODEBURN_BIN` does; and it has to be absolute for the
/// same reason every search directory does, since a relative one would resolve against
/// whatever directory this app was handed at login.
#[cfg(windows)]
fn recorded_cli_candidate(settings: &serde_json::Map<String, Value>) -> Option<String> {
    let raw = settings.get(DESKTOP_CLI_KEY)?.as_str()?.trim();
    if raw.is_empty() || !is_safe_arg(raw) {
        return None;
    }
    std::path::Path::new(raw)
        .is_absolute()
        .then(|| raw.to_string())
}

fn find_in_search_dirs(names: &[&str]) -> Option<String> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = env::var_os("PATH") {
        dirs.extend(env::split_paths(&path));
    }
    dirs.extend(extra_search_dirs());
    find_in_dirs(&dirs, names)
}

/// The absolute-only filter is the security boundary, so it lives here where every search
/// goes through it. `env::split_paths` yields an empty `PathBuf` for `;;` or a trailing `;`,
/// and the registry PATH can hold relative entries too; `PathBuf::from("").join("codeburn.cmd")`
/// resolves against the current directory, which for a tray app launched at login is
/// whatever Explorer handed it. A binary planted there must never win.
fn find_in_dirs(dirs: &[PathBuf], names: &[&str]) -> Option<String> {
    for dir in dirs.iter().filter(|d| d.is_absolute()) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

fn candidate_names() -> Vec<&'static str> {
    #[cfg(windows)]
    {
        WINDOWS_CLI_NAMES.to_vec()
    }
    #[cfg(not(windows))]
    {
        vec!["codeburn"]
    }
}

#[cfg(windows)]
fn extra_search_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for var in ["APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(base) = env::var_os(var).map(PathBuf::from) {
            match var {
                "APPDATA" => out.push(base.join("npm")),
                "LOCALAPPDATA" => {
                    out.push(base.join("Programs").join("nodejs"));
                    out.push(base.join("pnpm"));
                    out.push(base.join("Volta").join("bin"));
                    out.push(base.join("fnm_multishells"));
                }
                _ => out.push(base.join("nodejs")),
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        out.push(home.join("scoop").join("shims"));
        out.push(home.join(".bun").join("bin"));
    }
    // Volta writes package shims (`codeburn.cmd`) to `%VOLTA_HOME%\bin`, not to Program Files
    // where its installer keeps the node and npm shims, so `node` works from any prompt while
    // `codeburn` lives wherever VOLTA_HOME points. The default home is probed above; this is
    // the relocated one (#1532: `D:\Data\Volta`).
    if let Some(dir) = volta_home_bin(env::var_os("VOLTA_HOME")) {
        out.push(dir);
    }
    out.extend(registry_path_dirs());
    out
}

/// `%VOLTA_HOME%\bin` for a set, non-empty VOLTA_HOME. A relative value is passed through and
/// dropped by `find_in_dirs`, like every other relative search entry.
#[cfg(windows)]
fn volta_home_bin(volta_home: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let home = volta_home?;
    if home.is_empty() {
        return None;
    }
    Some(PathBuf::from(home).join("bin"))
}

#[cfg(not(windows))]
fn extra_search_dirs() -> Vec<PathBuf> {
    let mut out = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = dirs::home_dir() {
        out.push(home.join(".npm-global").join("bin"));
        out.push(home.join(".local").join("bin"));
    }
    out
}

/// Windows' `CreateProcess` searches the current directory before `PATH`, so spawning
/// `reg` or `cmd` by bare name lets anything dropped next to the app impersonate a system
/// tool -- and the tray badge re-runs `reg query` every refresh. Always spawn the real one
/// out of `%SystemRoot%\System32`, falling back to the documented default when the
/// environment variable is missing or relative.
#[cfg(windows)]
pub fn system32_path(exe: &str) -> PathBuf {
    let root = env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join(exe)
}

/// `system32_path` plus the CREATE_NO_WINDOW flag every one of these callers wants.
#[cfg(windows)]
pub fn system_command(exe: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = std::process::Command::new(system32_path(exe));
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Reads the user and machine PATH values from the registry via `reg.exe` so a PATH edit
/// made after this process started (npm install adds `%APPDATA%\npm`) is still honoured.
#[cfg(windows)]
fn registry_path_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let keys = [
        r"HKCU\Environment",
        r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
    ];
    for key in keys {
        let output = system_command("reg.exe")
            .args(["query", key, "/v", "Path"])
            .output();
        let Ok(output) = output else { continue };
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with("Path") {
                continue;
            }
            let Some(idx) = trimmed.find("REG_") else { continue };
            let rest = &trimmed[idx..];
            let Some(space) = rest.find(char::is_whitespace) else { continue };
            let value = rest[space..].trim();
            for part in value.split(';') {
                let expanded = expand_env(part.trim());
                if !expanded.is_empty() {
                    out.push(PathBuf::from(expanded));
                }
            }
        }
    }
    out
}

#[cfg(windows)]
fn expand_env(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        result.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match env::var(name) {
                    Ok(v) => result.push_str(&v),
                    Err(_) => {
                        result.push('%');
                        result.push_str(name);
                        result.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                result.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    result.push_str(rest);
    result
}

/// Opens the folder holding `path` with `path` itself selected: the Windows counterpart of
/// the mac's `NSWorkspace.activateFileViewerSelecting`, which is what the export reveal has
/// always done there. `explorer.exe` is spawned out of `%SystemRoot%` for the same reason
/// every other system tool here is, and its exit code is ignored because it reports 1 on a
/// perfectly successful open.
#[cfg(windows)]
pub fn reveal_in_file_manager(path: &std::path::Path) -> Result<()> {
    let root = env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    // One argument, comma-joined: `/select,C:\path`. Passing them as two would open the
    // reader's Documents folder instead, which is explorer's answer to an unparsed switch.
    let mut arg = std::ffi::OsString::from("/select,");
    arg.push(path.as_os_str());
    std::process::Command::new(root.join("explorer.exe"))
        .arg(arg)
        .spawn()
        .with_context(|| "could not open Explorer")?;
    Ok(())
}

#[cfg(not(windows))]
pub fn reveal_in_file_manager(path: &std::path::Path) -> Result<()> {
    let target = path.parent().unwrap_or(path);
    std::process::Command::new("xdg-open")
        .arg(target)
        .spawn()
        .with_context(|| "could not open the file manager")?;
    Ok(())
}

/// The codeburn subcommands a page is allowed to open a console for. Every one of them reads
/// what is already on disk and prints it; none takes a destination, a path or a credential.
const TERMINAL_SUBCOMMANDS: [&str; 7] = [
    "report",
    "optimize",
    "doctor",
    "quota",
    "models",
    "sessions",
    "compare",
];

/// The argv a page hands `open_terminal_command` is a name from this list and nothing else.
/// `is_safe_arg` only keeps shell metacharacters out; it would still forward
/// `["sync", "--push", "https://elsewhere"]`, which is not a report anybody asked for. An
/// option the UI needs later is added here deliberately, with its value checked.
pub fn is_allowed_subcommand(args: &[&str]) -> bool {
    matches!(args, [name] if TERMINAL_SUBCOMMANDS.contains(name))
}

/// Runs a codeburn subcommand in the user's terminal emulator so they can see the output.
/// Linux: tries `x-terminal-emulator`, `gnome-terminal`, `konsole`, then falls back to a
/// detached headless spawn. Windows: opens a console via `cmd /C start`. Never
/// interpolates through a shell -- argv throughout.
pub fn spawn_in_terminal(app: &AppHandle, subcommand: &[&str]) -> Result<()> {
    let cli = CodeburnCli::resolve();
    spawn_program_in_terminal(app, &cli, subcommand)
}

/// The Plan view's "Connect Claude" runs Claude Code's own login flow, not codeburn. The
/// binary is located up front rather than handed to the console shell as a bare name, so
/// the same absolute-directory rule that protects the codeburn lookup applies here too.
pub fn spawn_claude_login(app: &AppHandle) -> Result<()> {
    let program = locate_claude().ok_or_else(|| {
        anyhow!("Claude Code was not found on this machine. Install it, then try again.")
    })?;
    let cli = CodeburnCli {
        program,
        extra_args: vec![],
    };
    spawn_program_in_terminal(app, &cli, &["login"])
}

fn spawn_program_in_terminal(_app: &AppHandle, cli: &CodeburnCli, subcommand: &[&str]) -> Result<()> {
    if !subcommand.iter().all(|s| is_safe_arg(s)) {
        bail!("unsafe subcommand argument");
    }

    #[cfg(target_os = "linux")]
    {
        let mut command_parts: Vec<String> = vec![cli.program.clone()];
        command_parts.extend(cli.extra_args.clone());
        command_parts.extend(subcommand.iter().map(|s| s.to_string()));
        // Terminal emulators take the command as one string that a shell then parses
        // (gnome-terminal explicitly hands it to `bash -lc`). `cli.program` reaches here
        // from PATH resolution, not only from the allowlisted CODEBURN_BIN, so re-check
        // every part before joining; anything a shell could reinterpret skips the terminal
        // and goes through the argv-only detached spawn below.
        if command_parts.iter().all(|p| is_safe_arg(p)) {
            let composite = command_parts.join(" ");
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
                    let mut cmd = std::process::Command::new(program);
                    cmd.args(extras);
                    cmd.arg(&composite);
                    cmd.spawn().with_context(|| format!("failed to launch {}", program))?;
                    return Ok(());
                }
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
        // Only the unresolved default name is worth a second lookup; anything else is
        // either already absolute or a CODEBURN_BIN the user chose.
        let program = if cli.program == default_program_name() {
            locate_cli().unwrap_or_else(|| cli.program.clone())
        } else {
            cli.program.clone()
        };
        let mut argv: Vec<String> = vec![program];
        argv.extend(cli.extra_args.iter().cloned());
        argv.extend(subcommand.iter().map(|s| s.to_string()));

        // `start` treats the first quoted argument as the window title, so we pass an
        // explicit empty title. It also detaches, which is what keeps the console the
        // reader gets from being a child of this GUI process.
        let mut cmd = system_command("cmd.exe");
        cmd.arg("/C").arg("start").arg("");
        for arg in PreferredTerminal::resolved().launch_argv(&argv) {
            cmd.arg(arg);
        }
        cmd.spawn().with_context(|| "failed to open a terminal")?;
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

/// The Windows counterpart of mac/.../Security/PreferredTerminal.swift, and it exists for the
/// same reason: a user preference must never become a free-form string inside a command line.
/// The stored value is parsed back through `parse`, anything unrecognised collapses to the
/// default, and every executable named below is a compile-time literal resolved from
/// %SystemRoot% or %LOCALAPPDATA%.
///
/// Only consoles that can hold a command open in a live window are listed. That is what
/// Full Report and Optimize need: a window that stays after the command exits.
#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreferredTerminal {
    WindowsTerminal,
    PowerShell,
    CommandPrompt,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOption {
    pub id: &'static str,
    pub installed: bool,
}

#[cfg(target_os = "windows")]
impl PreferredTerminal {
    pub const ALL: [PreferredTerminal; 3] = [
        PreferredTerminal::WindowsTerminal,
        PreferredTerminal::PowerShell,
        PreferredTerminal::CommandPrompt,
    ];

    pub fn id(self) -> &'static str {
        match self {
            PreferredTerminal::WindowsTerminal => "windowsTerminal",
            PreferredTerminal::PowerShell => "powershell",
            PreferredTerminal::CommandPrompt => "commandPrompt",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|term| term.id() == value)
    }

    /// Windows Terminal ships as an app-execution alias in the per-user WindowsApps folder;
    /// PowerShell and the Command Prompt are always where %SystemRoot% says.
    fn path(self) -> PathBuf {
        match self {
            PreferredTerminal::WindowsTerminal => dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from(r"C:\"))
                .join("Microsoft")
                .join("WindowsApps")
                .join("wt.exe"),
            PreferredTerminal::PowerShell => system32_path("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe"),
            PreferredTerminal::CommandPrompt => system32_path("cmd.exe"),
        }
    }

    pub fn is_installed(self) -> bool {
        self.path().is_file()
    }

    /// The stored choice, falling back to whatever is actually installed. The Command Prompt
    /// is the last rung and is always present, so this can never come back empty.
    pub fn resolved() -> Self {
        let stored = crate::settings::read()
            .get("terminal")
            .and_then(serde_json::Value::as_str)
            .and_then(Self::parse);
        match stored {
            Some(term) if term.is_installed() => term,
            _ => Self::ALL
                .into_iter()
                .find(|term| term.is_installed())
                .unwrap_or(PreferredTerminal::CommandPrompt),
        }
    }

    /// The argv that opens this console on `argv`, ready to hand to `cmd /C start ""`.
    ///
    /// `argv` is the codeburn command, token by token; every token has already passed
    /// `is_safe_arg`, so none of them carries a quote, a `$`, a backtick or a `;`. That is
    /// what makes the PowerShell line safe to build: it is the one case where the tokens are
    /// re-parsed by a shell rather than passed straight through as argv.
    fn launch_argv(self, argv: &[String]) -> Vec<String> {
        let cmd_exe = system32_path("cmd.exe").to_string_lossy().into_owned();
        let hold_open = |program: String| {
            let mut out = vec![program, "/K".to_string()];
            out.extend(argv.iter().cloned());
            out
        };
        match self {
            PreferredTerminal::CommandPrompt => hold_open(cmd_exe),
            // Windows Terminal takes the command line to run as its trailing arguments, so
            // the console that actually holds the command open is still cmd.
            PreferredTerminal::WindowsTerminal => {
                let mut out = vec![self.path().to_string_lossy().into_owned()];
                out.extend(hold_open(cmd_exe));
                out
            }
            PreferredTerminal::PowerShell => {
                if !argv.iter().all(|token| is_safe_arg(token)) {
                    return hold_open(cmd_exe);
                }
                let script = std::iter::once(format!("& '{}'", argv[0]))
                    .chain(argv[1..].iter().cloned())
                    .collect::<Vec<_>>()
                    .join(" ");
                vec![
                    self.path().to_string_lossy().into_owned(),
                    "-NoExit".to_string(),
                    "-Command".to_string(),
                    script,
                ]
            }
        }
    }
}

/// What the settings window lists, with the ones that are not on this machine marked so the
/// "(not installed)" hint stays honest.
#[cfg(target_os = "windows")]
pub fn terminals() -> Vec<TerminalOption> {
    PreferredTerminal::ALL
        .into_iter()
        .map(|term| TerminalOption {
            id: term.id(),
            installed: term.is_installed(),
        })
        .collect()
}

/// Linux and macOS pick a terminal by probing for one at launch, so there is nothing for the
/// settings window to offer; it hides the control when this list is empty.
#[cfg(not(target_os = "windows"))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOption {
    pub id: &'static str,
    pub installed: bool,
}

#[cfg(not(target_os = "windows"))]
pub fn terminals() -> Vec<TerminalOption> {
    Vec::new()
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
        let dirs: Vec<PathBuf> = env::split_paths(&path).collect();
        super::find_in_dirs(&dirs, &[program]).map(PathBuf::from).ok_or(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_named_read_only_subcommand_opens_a_terminal() {
        assert!(is_allowed_subcommand(&["report"]));
        assert!(is_allowed_subcommand(&["optimize"]));
        assert!(is_allowed_subcommand(&["doctor"]));

        // Nothing at all, and a subcommand that is not on the list.
        assert!(!is_allowed_subcommand(&[]));
        assert!(!is_allowed_subcommand(&["serve"]));
        assert!(!is_allowed_subcommand(&["login"]));
        // Matching is exact: no case folding, no path, no repeat.
        assert!(!is_allowed_subcommand(&["Report"]));
        assert!(!is_allowed_subcommand(&["./report"]));
        assert!(!is_allowed_subcommand(&["report", "report"]));
        // Arguments alongside an allowed name are what the allowlist exists to stop: each of
        // these passes `is_safe_arg` on its own.
        assert!(!is_allowed_subcommand(&["report", "--json"]));
        assert!(!is_allowed_subcommand(&["sync", "--push", "https://elsewhere.example"]));
    }

    /// The `;;` / trailing-`;` case: an empty PATH entry must not turn into a
    /// current-directory lookup, which is how a planted binary would win at login.
    #[test]
    fn find_in_dirs_skips_empty_and_relative_entries() {
        let dir = std::env::temp_dir();
        let name = "codeburn-menubar-locate-probe";
        let planted = dir.join(name);
        std::fs::write(&planted, b"probe").unwrap();

        // Empty and relative entries are ignored even though the file is reachable
        // through them once the process CWD is the temp dir.
        let unsafe_dirs = vec![PathBuf::from(""), PathBuf::from("."), PathBuf::from("..")];
        assert_eq!(find_in_dirs(&unsafe_dirs, &[name]), None);

        // The same name behind an absolute entry is found.
        let found = find_in_dirs(std::slice::from_ref(&dir), &[name]).expect("absolute entry should match");
        assert!(PathBuf::from(&found).is_absolute());
        assert!(found.ends_with(name));

        // An unsafe entry ahead of a good one cannot shadow it.
        let mixed = vec![PathBuf::from(""), dir.clone()];
        assert_eq!(find_in_dirs(&mixed, &[name]), Some(found));

        std::fs::remove_file(&planted).ok();
    }

    /// The lookup that lets a machine with only the CodeBurn desktop app on it have a CLI.
    /// The disk check is the caller's; what is worth pinning is which recorded values are
    /// allowed to become the program this app spawns.
    #[cfg(windows)]
    #[test]
    fn the_desktop_apps_recorded_cli_is_taken_only_when_it_looks_like_one() {
        fn recorded(value: Value) -> Option<String> {
            let mut settings = serde_json::Map::new();
            settings.insert(DESKTOP_CLI_KEY.to_string(), value);
            recorded_cli_candidate(&settings)
        }

        let launcher = r"C:\Users\a\AppData\Local\codeburn-menubar\codeburn-cli.cmd";
        assert_eq!(recorded(Value::from(launcher)), Some(launcher.to_string()));
        // A path under Program Files has a space in it and is still fine.
        let spaced = r"C:\Program Files\CodeBurn\codeburn-cli.cmd";
        assert_eq!(recorded(Value::from(spaced)), Some(spaced.to_string()));

        // The CODEBURN_BIN allowlist, for the same reason: a resolved program reaches a
        // console command line, and nothing here may be reinterpreted there.
        assert_eq!(recorded(Value::from(r"C:\a\codeburn.cmd & calc.exe")), None);
        assert_eq!(recorded(Value::from("C:\\a\\\"codeburn.cmd\"")), None);
        // A relative entry resolves against whatever directory Explorer handed this app.
        assert_eq!(recorded(Value::from("codeburn-cli.cmd")), None);
        assert_eq!(recorded(Value::from("")), None);
        assert_eq!(recorded(Value::from(42)), None);
        assert_eq!(recorded_cli_candidate(&serde_json::Map::new()), None);
    }

    /// Nothing resolved at all is a different message from a CLI that is there and would not
    /// start, because the two have different answers.
    #[test]
    fn a_machine_with_no_cli_anywhere_is_told_about_both_ways_to_get_one() {
        let missing = std::io::Error::new(std::io::ErrorKind::NotFound, "not found");
        let nothing = spawn_failure_message(&default_program_name(), &missing);
        assert!(nothing.contains("desktop app"), "{}", nothing);
        assert!(nothing.contains("npm install -g codeburn"), "{}", nothing);

        let denied = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let named = spawn_failure_message("/usr/local/bin/codeburn", &denied);
        assert!(named.contains("/usr/local/bin/codeburn"), "{}", named);
        assert!(!named.contains("desktop app"), "{}", named);
    }

    #[cfg(windows)]
    #[test]
    fn volta_home_bin_follows_a_relocated_volta_home() {
        use std::ffi::OsString;
        assert_eq!(
            volta_home_bin(Some(OsString::from(r"D:\Data\Volta"))),
            Some(PathBuf::from(r"D:\Data\Volta\bin"))
        );
        assert_eq!(volta_home_bin(Some(OsString::from(""))), None);
        assert_eq!(volta_home_bin(None), None);
    }

    #[test]
    fn parse_version_reads_bare_and_prefixed_output() {
        assert_eq!(parse_version("0.9.9"), Some((0, 9, 9)));
        assert_eq!(parse_version("codeburn 0.9.20\n"), Some((0, 9, 20)));
        assert_eq!(parse_version("1.0"), Some((1, 0, 0)));
        assert_eq!(parse_version("0.10.0-beta.1"), Some((0, 10, 0)));
        assert_eq!(parse_version("no version here"), None);
    }

    /// The gate is a plain tuple compare, so the only thing worth pinning is that the
    /// versions on either side of MIN_CLI_VERSION land on the right side of it.
    #[test]
    fn version_gate_rejects_only_older_clis() {
        assert_eq!(MIN_CLI_VERSION, (0, 9, 9));
        assert!(parse_version("0.9.8").unwrap() < MIN_CLI_VERSION);
        assert!(parse_version("0.9.9").unwrap() >= MIN_CLI_VERSION);
        assert!(parse_version("0.9.20").unwrap() >= MIN_CLI_VERSION);
        assert!(parse_version("0.10.0").unwrap() >= MIN_CLI_VERSION);
    }

    /// A long run that keeps talking is the normal case for a cold parse of a large corpus,
    /// and killing it was the whole reason the flat timeout had to go.
    #[test]
    fn a_chatty_child_is_left_alone_however_long_it_runs() {
        assert_eq!(
            verdict(600.0, 1.0, SILENCE_SECS as f64),
            Verdict::Wait,
            "ten minutes of work with output a second ago is a healthy parse"
        );
    }

    #[test]
    fn a_silent_child_is_stopped_at_the_window_and_not_before() {
        let window = SILENCE_SECS as f64;
        assert_eq!(verdict(60.0, window - 0.5, window), Verdict::Wait);
        assert_eq!(verdict(60.0, window, window), Verdict::Silent);
    }

    /// The backstop: a child that chatters forever without finishing is still reaped, and
    /// silence wins when both apply, since it is the more specific diagnosis.
    #[test]
    fn the_ceiling_catches_a_child_that_never_finishes() {
        let window = SILENCE_SECS as f64;
        assert_eq!(
            verdict(CEILING_SECS as f64 - 1.0, 1.0, window),
            Verdict::Wait
        );
        assert_eq!(verdict(CEILING_SECS as f64, 1.0, window), Verdict::Ceiling);
        assert_eq!(
            verdict(CEILING_SECS as f64, window, window),
            Verdict::Silent
        );
    }

    #[test]
    fn the_cold_budget_applies_until_one_payload_has_come_back() {
        assert_eq!(silence_window(false), COLD_SILENCE_SECS);
        assert_eq!(silence_window(true), SILENCE_SECS);
        assert!(silence_window(false) > silence_window(true));
    }

    /// Progress lines share stderr with real diagnostics, and every read spawn now turns
    /// them on, so they must never become the error a window shows.
    #[test]
    fn progress_heartbeats_are_not_an_error_message() {
        let stderr = format!(
            "{}{}\nreal failure\n{}{}\n",
            PROGRESS_LINE_PREFIX,
            "{\"kind\":\"keepalive\"}",
            PROGRESS_LINE_PREFIX,
            "{\"kind\":\"scan\"}"
        );
        assert_eq!(without_progress_lines(&stderr), "real failure");
        assert_eq!(
            without_progress_lines(&format!("{PROGRESS_LINE_PREFIX}x\n")),
            ""
        );
        assert_eq!(without_progress_lines("  plain error  "), "plain error");
    }
}
