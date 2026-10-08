//! Is there a newer tray app, is there a newer CLI, and where the reader gets it.
//!
//! Port of `mac/Sources/CodeBurnMenubar/Data/UpdateChecker.swift`, with the Windows release
//! line in place of the mac one: the app ships as an `.msi` under a `windows-v*` tag rather
//! than a zip under `mac-v*`. The check is the same on every route. The install is not.
//!
//! A signature is required before anything installs in one click. The MSI's `.sha256` sits in
//! the same GitHub release, so it proves nothing about who built the file: whoever can replace
//! the one replaces the other. The updater's minisign signature does: the private key lives in
//! CI secrets, never in a release, and the public key is compiled into this binary. So on
//! Windows, once tauri.conf.json carries a real `plugins.updater.pubkey`, an available update
//! gets one button: `download` fetches the MSI that `update-feeds/windows-latest.json` names
//! and refuses it unless the signature verifies, and `install` runs it. Without the key, and on
//! Linux, an available update is answered with a release page and a command to run by hand.
//!
//! Inside a Store package nothing is offered at all: the Store owns the update, and an .msi
//! install underneath it would be undone by the next one.
//!
//! The check runs here rather than in the page for two reasons: the answer has to survive a
//! popover that is closed most of the time, and the webview's CSP has no business reaching
//! api.github.com when the fetch can be made from a place that already talks HTTPS.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::cli::CodeburnCli;

const RELEASES_API: &str =
    "https://api.github.com/repos/getagentseal/codeburn/releases?per_page=20";
const USER_AGENT: &str = "codeburn-menubar-updater";
/// The mac's checkIntervalSeconds. A release cadence measured in weeks does not need asking
/// about more often than this, and the answer is cached on disk so a relaunch does not spend
/// a request either.
const CHECK_INTERVAL_SECS: u64 = 2 * 24 * 60 * 60;
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// Twenty releases with their asset lists is a few tens of kilobytes. Anything past this is
/// not the GitHub API answering, and the body is read in chunks so an endless one is dropped
/// rather than buffered.
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// The longest scrubbed message worth putting in front of a reader.
const MAX_DISPLAYED_CHARS: usize = 1_000;

/// What the reader is told to run by hand. Windows installs the CLI from npm; there is no
/// Homebrew branch to mirror.
pub const CLI_UPDATE_COMMAND: &str = "npm update -g codeburn";

/// The manual app install. `codeburn menubar --force` is `src/menubar-installer.ts`: it
/// resolves the release, verifies the `.sha256` and hands the file to
/// `msiexec /i <msi> /passive /norestart`. The reader runs it; this app does not.
pub const APP_UPDATE_COMMAND: &str = "codeburn menubar --force";

/// Where "Download from GitHub" goes. The `windows-v*` tag page carries the `.msi` and its
/// checksum; the index is the fallback for a check that never named a version.
const RELEASES_PAGE: &str = "https://github.com/getagentseal/codeburn/releases";

fn release_page(version: Option<&str>) -> String {
    match version {
        Some(version) => format!("{RELEASES_PAGE}/tag/windows-v{version}"),
        None => RELEASES_PAGE.to_owned(),
    }
}

/// The Windows MSI asset name, from `WINDOWS_RELEASE` in `src/menubar-installer.ts`. GitHub
/// rewrites the spaces in the product name to dots when it stores the asset, so the version
/// sits between a dotted prefix and the architecture suffix.
const MSI_PREFIX: &str = "CodeBurn.Menubar_";
const MSI_SUFFIX: &str = "_x64_en-US.msi";

/// The oldest CLI whose `menubar --force` can install the Windows app at all: the Windows
/// branch of the installer landed in 0.9.21 (commit 527e5807). An older one downloads a mac
/// zip on a machine that cannot open it, so the page asks for the CLI first, exactly as the
/// mac refuses anything below 0.9.9.
const MIN_CLI_VERSION_FOR_UPDATE: (u32, u32, u32) = (0, 9, 21);

// The GitHub payload ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct GitHubAsset {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct GitHubRelease {
    pub tag_name: String,
    #[serde(default)]
    pub assets: Vec<GitHubAsset>,
}

/// The version an MSI asset name carries, or None when the asset is something else.
fn msi_version(name: &str) -> Option<&str> {
    name.strip_prefix(MSI_PREFIX)?.strip_suffix(MSI_SUFFIX)
}

/// The newest `windows-v*` release that carries an installable: an `.msi` and the `.sha256`
/// beside it. A release missing either is skipped rather than reported, because
/// `codeburn menubar` verifies the checksum before anything executes and would fail on it.
///
/// What that checksum is worth, stated plainly, because it is easy to read as more than it
/// is. The `.sha256` comes from the same GitHub release as the `.msi` it describes, so it
/// proves the download arrived intact and says nothing about who produced it: anyone who can
/// publish to that release, or who can stand between this app and api.github.com with a
/// certificate the machine trusts, replaces both files together and the check still passes.
/// Nor can Windows tell the user otherwise, since the MSI is unsigned: SmartScreen warns of
/// an unknown publisher and the elevation prompt says "Unknown". The trust boundary is the
/// GitHub release, not the installer.
///
/// The one-click route does not lean on it: `download` checks the updater signature instead.
pub fn resolve_latest_windows_version(releases: &[GitHubRelease]) -> Option<String> {
    for release in releases
        .iter()
        .filter(|release| release.tag_name.starts_with("windows-v"))
    {
        let Some(asset) = release
            .assets
            .iter()
            .find(|asset| msi_version(&asset.name).is_some())
        else {
            continue;
        };
        let checksum = format!("{}.sha256", asset.name);
        if !release.assets.iter().any(|other| other.name == checksum) {
            continue;
        }
        return msi_version(&asset.name).map(str::to_owned);
    }
    None
}

/// The newest CLI release. Its tags are a bare `v<version>`, so the two platform lines
/// (`mac-v*`, `windows-v*`) are excluded by the prefix alone.
pub fn resolve_latest_cli_version(releases: &[GitHubRelease]) -> Option<String> {
    releases
        .iter()
        .find(|release| release.tag_name.starts_with('v'))
        .map(|release| release.tag_name.trim_start_matches('v').to_owned())
}

/// Strictly newer, by the same numeric comparison the CLI gate uses. An unparseable version
/// on either side is not an update: guessing would either nag forever or hide a real one.
fn is_newer(latest: &str, current: &str) -> bool {
    match (
        crate::cli::parse_version(latest),
        crate::cli::parse_version(current),
    ) {
        (Some(latest), Some(current)) => latest > current,
        _ => false,
    }
}

fn is_cli_too_old(installed: Option<&str>) -> bool {
    installed
        .and_then(crate::cli::parse_version)
        .is_some_and(|version| version < MIN_CLI_VERSION_FOR_UPDATE)
}

/// True when this process runs from an installed MSIX/AppX package. The Store build of the
/// desktop app ships this tray app inside its own package, and a package updates as one thing:
/// an .msi install underneath it would be undone by the next Store update at best, and refused
/// at worst. `GetCurrentPackageFullName` is the documented ask - it answers
/// APPMODEL_ERROR_NO_PACKAGE outside a package and a buffer complaint inside one, which is why
/// the length is asked for with no buffer to put it in.
#[cfg(target_os = "windows")]
pub fn is_packaged_app() -> bool {
    use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
    const APPMODEL_ERROR_NO_PACKAGE: u32 = 15700;

    let mut length: u32 = 0;
    let code = unsafe { GetCurrentPackageFullName(&mut length, std::ptr::null_mut()) };
    code != APPMODEL_ERROR_NO_PACKAGE
}

#[cfg(not(target_os = "windows"))]
pub fn is_packaged_app() -> bool {
    false
}

// What the page renders -------------------------------------------------------------------

/// Which stage failed, so the badge can say so. The mac's UpdateFailureStage, down to the
/// check: a failed download or install answers the click that started it instead.
/// The labels and the help text live in the page, since that is where they are read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureStage {
    Check,
}

/// Where an update comes from on this install. The page switches its copy on it: a Store
/// package is told nothing is needed, a signed Windows build gets the one-click button, and
/// everywhere else is offered the release page and the command.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallRoute {
    Store,
    Manual,
    OneClick,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub latest_cli_version: Option<String>,
    pub installed_cli_version: Option<String>,
    pub update_available: bool,
    pub cli_update_available: bool,
    /// Too old to install the app even though it may not be the newest release.
    pub cli_too_old: bool,
    pub cli_update_command: &'static str,
    /// The command that installs the newer app, for the reader to run in a terminal.
    pub app_update_command: &'static str,
    /// How an update is installed here, and so what the surfaces offer.
    pub install_route: InstallRoute,
    /// The `windows-v*` release page for the version on offer, or the releases index when
    /// the check has not named one.
    pub release_url: String,
    /// Unix seconds of the last answer GitHub gave, cached or fresh.
    pub checked_at: Option<u64>,
    pub failure_stage: Option<FailureStage>,
    pub error: Option<String>,
    /// Running inside an installed MSIX/AppX package, where the Store owns updates and this
    /// checker has nothing to offer. Every update surface hides itself on it.
    pub store_managed: bool,
    /// A verified update is downloaded and waits for Restart to Update.
    pub ready_to_install: bool,
}

impl UpdateStatus {
    fn new(current_version: String) -> Self {
        UpdateStatus {
            current_version,
            latest_version: None,
            latest_cli_version: None,
            installed_cli_version: None,
            update_available: false,
            cli_update_available: false,
            cli_too_old: false,
            cli_update_command: CLI_UPDATE_COMMAND,
            app_update_command: APP_UPDATE_COMMAND,
            install_route: InstallRoute::Manual,
            release_url: release_page(None),
            checked_at: None,
            failure_stage: None,
            error: None,
            store_managed: false,
            ready_to_install: false,
        }
    }

    /// The whole answer for a packaged install: nothing was asked of GitHub, nothing is
    /// offered, and the surfaces read `store_managed` rather than a silence they would
    /// otherwise show as "up to date" with a Check for Updates button beside it.
    fn store_managed(current_version: String) -> Self {
        UpdateStatus {
            store_managed: true,
            install_route: InstallRoute::Store,
            ..UpdateStatus::new(current_version)
        }
    }

    /// Everything derived from the versions: what is on offer, whether the installed CLI
    /// can install it, and where the reader is sent to get it. Run at the end of a check,
    /// which is the only place a version moves now.
    fn recompute(&mut self) {
        self.update_available = self
            .latest_version
            .as_deref()
            .is_some_and(|latest| is_newer(latest, &self.current_version));
        self.cli_update_available = match (
            self.latest_cli_version.as_deref(),
            self.installed_cli_version.as_deref(),
        ) {
            (Some(latest), Some(installed)) => is_newer(latest, installed),
            _ => false,
        };
        self.cli_too_old = is_cli_too_old(self.installed_cli_version.as_deref());
        // Only a version actually on offer gets a tag page; anything else would send the
        // reader to a release that has nothing newer in it.
        self.release_url = release_page(if self.update_available {
            self.latest_version.as_deref()
        } else {
            None
        });
    }
}

// The disk cache ---------------------------------------------------------------------------

/// Beside the tray's own status file, for the same reason: the answer has to be there before
/// any webview is, and a relaunch must not spend a request to learn what it already knew.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cached {
    #[serde(default)]
    checked_at: u64,
    #[serde(default)]
    latest: Option<String>,
    #[serde(default)]
    latest_cli: Option<String>,
}

fn cache_path() -> Option<PathBuf> {
    Some(
        dirs::data_local_dir()?
            .join("codeburn-menubar")
            .join("update.json"),
    )
}

fn read_cache() -> Option<Cached> {
    let path = cache_path()?;
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn write_cache(cached: &Cached) -> Result<()> {
    let path = cache_path().context("no local app data directory")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(cached)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

fn is_fresh(checked_at: u64) -> bool {
    checked_at > 0 && now_secs().saturating_sub(checked_at) < CHECK_INTERVAL_SECS
}

// The check ---------------------------------------------------------------------------------

async fn fetch_releases() -> Result<Vec<GitHubRelease>> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        // Plain HTTP is refused outright, redirect included: this answer decides which
        // release the reader is sent to.
        .https_only(true)
        .build()?;
    let mut response = client
        .get(RELEASES_API)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;
    if !response.status().is_success() {
        bail!("GitHub returned HTTP {}.", response.status().as_u16());
    }
    let mut body: Vec<u8> = Vec::with_capacity(64 * 1024);
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            bail!("The releases response was larger than expected.");
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).context("GitHub returned unexpected JSON")
}

async fn installed_cli_version(cli: &CodeburnCli) -> Option<String> {
    cli.status().await.version
}

/// The current answer, and the only thing this module does about an update. `force` skips
/// the two-day gate; without it a cached answer inside the interval is returned untouched,
/// which is what makes this cheap to call on every mount.
pub async fn check(app: &AppHandle, cli: &CodeburnCli, force: bool) -> UpdateStatus {
    // Inside a package the Store is the updater. Running this one there would offer an .msi
    // install that MSIX would either refuse or quietly undo on its next update, so the check
    // never happens: no request, no `codeburn --version` spawn, no cache file.
    if is_packaged_app() {
        return UpdateStatus::store_managed(app.package_info().version.to_string());
    }

    let mut status = UpdateStatus::new(app.package_info().version.to_string());
    status.installed_cli_version = installed_cli_version(cli).await;
    if cfg!(target_os = "windows") && pubkey_is_set(configured_pubkey(app).as_deref()) {
        status.install_route = InstallRoute::OneClick;
    }
    status.ready_to_install = pending().is_some();

    let cached = read_cache().unwrap_or_default();
    if !force && is_fresh(cached.checked_at) {
        status.latest_version = cached.latest;
        status.latest_cli_version = cached.latest_cli;
        status.checked_at = Some(cached.checked_at);
        status.recompute();
        return status;
    }

    match fetch_releases().await {
        Ok(releases) => {
            let fresh = Cached {
                checked_at: now_secs(),
                latest: resolve_latest_windows_version(&releases),
                latest_cli: resolve_latest_cli_version(&releases),
            };
            if let Err(err) = write_cache(&fresh) {
                crate::log_line!("codeburn: failed to cache the update check: {err}");
            }
            status.latest_version = fresh.latest;
            status.latest_cli_version = fresh.latest_cli;
            status.checked_at = Some(fresh.checked_at);
        }
        Err(err) => {
            // A failed check keeps whatever the cache knew, so a badge already on screen does
            // not vanish because the network went away for a moment.
            status.latest_version = cached.latest;
            status.latest_cli_version = cached.latest_cli;
            status.checked_at = (cached.checked_at > 0).then_some(cached.checked_at);
            status.failure_stage = Some(FailureStage::Check);
            status.error = Some(scrub(&err.to_string()));
            crate::log_line!("codeburn: update check failed: {err}");
        }
    }
    status.recompute();
    status
}

// One-click install ----------------------------------------------------------------------------

/// What tauri.conf.json ships with until the maintainer runs `tauri signer generate`.
const PUBKEY_PLACEHOLDER: &str = "REPLACE_WITH_TAURI_UPDATER_PUBKEY";

fn pubkey_is_set(pubkey: Option<&str>) -> bool {
    pubkey.is_some_and(|key| !key.trim().is_empty() && key != PUBKEY_PLACEHOLDER)
}

fn configured_pubkey(app: &AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")?
        .get("pubkey")?
        .as_str()
        .map(str::to_owned)
}

static PENDING: Mutex<Option<(Update, Vec<u8>)>> = Mutex::new(None);

fn pending() -> std::sync::MutexGuard<'static, Option<(Update, Vec<u8>)>> {
    PENDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Fetches the MSI the feed names. The plugin verifies its minisign signature against the
/// compiled-in public key before this returns, so only a verified installer is kept.
pub async fn download(app: &AppHandle) -> Result<()> {
    let update = app
        .updater()?
        .check()
        .await?
        .context("The update feed has no newer release yet.")?;
    let bytes = update.download(|_, _| {}, || {}).await?;
    *pending() = Some((update, bytes));
    Ok(())
}

/// Runs the verified installer. On Windows the plugin hands it to msiexec with
/// AUTOLAUNCHAPP and exits, so the new version starts itself; elsewhere this restarts.
pub fn install(app: &AppHandle) -> Result<()> {
    let (update, bytes) = pending()
        .take()
        .context("No downloaded update to install.")?;
    update.install(bytes)?;
    app.restart()
}

// Scrubbing -----------------------------------------------------------------------------------

fn token_len(text: &str) -> usize {
    text.bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
        .count()
}

/// Three dot-separated `[A-Za-z0-9_-]` segments, the shape of a JWT.
fn jwt_len(rest: &str) -> Option<usize> {
    let mut pos = 0;
    for segment in 0..3 {
        if segment > 0 {
            if !rest[pos..].starts_with('.') {
                return None;
            }
            pos += 1;
        }
        let len = token_len(&rest[pos..]);
        if len == 0 {
            return None;
        }
        pos += len;
    }
    Some(pos)
}

/// A secret starting at `start`, as (what to print instead, where it ends).
fn secret_at(text: &str, start: usize) -> Option<(&'static str, usize)> {
    let rest = &text[start..];
    if let Some(after) = rest.strip_prefix("sk-ant-") {
        let len = token_len(after);
        if len > 0 {
            return Some(("sk-ant-***", start + "sk-ant-".len() + len));
        }
    }
    if let Some(after) = rest.strip_prefix("sk-") {
        let len = token_len(after);
        // The mac's `sk-[A-Za-z0-9_-]{16,}`: short enough and it is a word, not a key.
        if len >= 16 {
            return Some(("sk-***", start + "sk-".len() + len));
        }
    }
    if rest.starts_with("eyJ") {
        if let Some(len) = jwt_len(rest) {
            return Some(("eyJ***", start + len));
        }
    }
    // Compared as bytes rather than as a slice of the string: `&rest[..6]` would panic if
    // those six bytes ended inside a multi-byte character, and a scrubber that panics on
    // whatever a subprocess happened to print is worse than one that misses a token.
    if rest.len() >= 6 && rest.as_bytes()[..6].eq_ignore_ascii_case(b"bearer") {
        let after = &rest[6..];
        let spaces = after.len() - after.trim_start_matches([' ', '\t']).len();
        if spaces > 0 {
            let value = &after[spaces..];
            let len = value.len() - value.trim_start_matches(|c: char| !c.is_whitespace()).len();
            if len > 0 {
                return Some(("Bearer ***", start + 6 + spaces + len));
            }
        }
    }
    None
}

/// Whatever the failure said, made safe to show. A transport error quotes the request it
/// failed on, and this app's own child processes carry provider API keys in their
/// environment, so the four shapes the mac redacts are redacted here too before anything
/// reaches a window. Same order as `sanitizeForDisplay`, longest prefix first.
pub fn scrub(value: &str) -> String {
    let cleaned: String = value.chars().filter(|c| *c != '\0').collect();
    let mut out = String::with_capacity(cleaned.len());
    let mut index = 0;
    while index < cleaned.len() {
        if let Some((replacement, end)) = secret_at(&cleaned, index) {
            out.push_str(replacement);
            index = end;
            continue;
        }
        let ch = cleaned[index..].chars().next().unwrap_or('\u{FFFD}');
        out.push(ch);
        index += ch.len_utf8();
    }
    let trimmed = out.trim();
    if trimmed.chars().count() > MAX_DISPLAYED_CHARS {
        let head: String = trimmed.chars().take(MAX_DISPLAYED_CHARS).collect();
        return format!("{head}...");
    }
    trimmed.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Store owns updates inside a package, so nothing is offered and no stage can run.
    #[test]
    fn a_store_managed_status_offers_nothing() {
        let status = UpdateStatus::store_managed("0.9.23".into());

        assert_eq!(status.install_route, InstallRoute::Store);
        assert!(status.store_managed);
        assert!(!status.update_available);
        assert!(!status.cli_update_available);
        assert!(!status.cli_too_old);
        assert_eq!(status.latest_version, None);
        assert_eq!(status.checked_at, None);
        assert_eq!(status.failure_stage, None);
    }

    /// This test binary is an ordinary .exe, which is the branch every developer machine and
    /// the NSIS install take.
    #[test]
    fn an_unpackaged_process_is_not_store_managed() {
        assert!(!is_packaged_app());
    }

    /// Without the updater key an available update is answered with a page and a command.
    /// The only install is the plugin's signature-checked one, so this module never spawns an
    /// installer of its own. That is an absence with no seam to record a call on, so it is
    /// read off the module's own source: wiring an unverified installer in fails here first,
    /// which is where the module doc explaining why is read.
    #[test]
    fn without_the_updater_key_the_route_is_manual_and_nothing_is_spawned() {
        let mut status = UpdateStatus::new("0.9.23".into());
        status.latest_version = Some("0.9.24".into());
        status.installed_cli_version = Some("0.9.20".into());
        status.latest_cli_version = Some("0.9.24".into());
        status.recompute();

        assert_eq!(status.install_route, InstallRoute::Manual);
        assert!(!status.store_managed);
        assert!(status.update_available);
        assert_eq!(status.app_update_command, "codeburn menubar --force");
        assert_eq!(status.cli_update_command, "npm update -g codeburn");
        assert_eq!(
            status.release_url,
            "https://github.com/getagentseal/codeburn/releases/tag/windows-v0.9.24"
        );

        // Assembled rather than written out, so the test does not match itself in the source
        // it is reading.
        let source = include_str!("update.rs");
        for needle in [
            format!("{}::{}", "Command", "new"),
            format!(".{}(", "spawn"),
            format!("codeburn{}latest", "@"),
        ] {
            assert!(
                !source.contains(&needle),
                "update.rs starts an install again ({needle}); see the module doc"
            );
        }
    }

    /// The placeholder shipped in tauri.conf.json is not a key, so it never turns the button on.
    #[test]
    fn only_a_real_pubkey_enables_one_click() {
        assert!(!pubkey_is_set(None));
        assert!(!pubkey_is_set(Some("")));
        assert!(!pubkey_is_set(Some(PUBKEY_PLACEHOLDER)));
        assert!(pubkey_is_set(Some("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu")));
    }

    /// Nothing on offer sends nobody anywhere in particular: the index, not a tag page for a
    /// release the reader already has.
    #[test]
    fn the_release_page_is_the_index_until_a_newer_version_is_named() {
        let mut status = UpdateStatus::new("0.9.23".into());
        status.recompute();
        assert_eq!(
            status.release_url,
            "https://github.com/getagentseal/codeburn/releases"
        );

        status.latest_version = Some("0.9.23".into());
        status.recompute();
        assert!(!status.update_available);
        assert_eq!(
            status.release_url,
            "https://github.com/getagentseal/codeburn/releases"
        );
    }

    fn release(tag: &str, assets: &[&str]) -> GitHubRelease {
        GitHubRelease {
            tag_name: tag.to_owned(),
            assets: assets
                .iter()
                .map(|name| GitHubAsset {
                    name: (*name).to_owned(),
                })
                .collect(),
        }
    }

    fn msi(version: &str) -> String {
        format!("{MSI_PREFIX}{version}{MSI_SUFFIX}")
    }

    #[test]
    fn the_version_comes_off_the_msi_asset_name() {
        assert_eq!(msi_version(&msi("0.9.23")), Some("0.9.23"));
        assert_eq!(msi_version("CodeBurnMenubar-v0.9.23.zip"), None);
        assert_eq!(msi_version("CodeBurn.Menubar_0.9.23_arm64_en-US.msi"), None);
    }

    #[test]
    fn the_newest_windows_release_with_both_assets_wins() {
        let releases = vec![
            release("v0.9.24", &["codeburn-0.9.24.tgz"]),
            // No checksum: `codeburn menubar` verifies one before it runs anything, so this
            // release is not installable and must not be offered.
            release("windows-v0.9.24", &[&msi("0.9.24")]),
            release(
                "windows-v0.9.23",
                &[&msi("0.9.23"), &format!("{}.sha256", msi("0.9.23"))],
            ),
        ];
        assert_eq!(
            resolve_latest_windows_version(&releases),
            Some("0.9.23".to_owned())
        );
    }

    #[test]
    fn a_release_line_without_an_msi_is_skipped_rather_than_reported() {
        let releases = vec![
            release("mac-v0.9.24", &["CodeBurnMenubar-v0.9.24.zip"]),
            release("windows-v0.9.24", &["release-notes.md"]),
        ];
        assert_eq!(resolve_latest_windows_version(&releases), None);
    }

    #[test]
    fn the_cli_version_comes_from_the_bare_tag_only() {
        let releases = vec![
            release("windows-v0.9.24", &[]),
            release("mac-v0.9.24", &[]),
            release("v0.9.23", &[]),
            release("v0.9.22", &[]),
        ];
        assert_eq!(
            resolve_latest_cli_version(&releases),
            Some("0.9.23".to_owned())
        );
        assert_eq!(resolve_latest_cli_version(&[]), None);
    }

    #[test]
    fn only_a_strictly_newer_version_is_an_update() {
        assert!(is_newer("0.9.24", "0.9.23"));
        assert!(is_newer("0.10.0", "0.9.30"));
        assert!(!is_newer("0.9.23", "0.9.23"));
        assert!(!is_newer("0.9.22", "0.9.23"));
        // Nothing to compare is not an update; a nag nobody can clear is worse than silence.
        assert!(!is_newer("nightly", "0.9.23"));
        assert!(!is_newer("0.9.24", "dev"));
    }

    #[test]
    fn a_cli_older_than_the_windows_installer_cannot_install_the_app() {
        assert!(is_cli_too_old(Some("0.9.20")));
        assert!(is_cli_too_old(Some("0.9.9")));
        assert!(!is_cli_too_old(Some("0.9.21")));
        assert!(!is_cli_too_old(Some("0.9.23")));
        // Nothing known means nothing to refuse; the spawn itself reports a missing CLI.
        assert!(!is_cli_too_old(None));
        assert!(!is_cli_too_old(Some("")));
    }

    #[test]
    fn keys_never_reach_the_window() {
        assert_eq!(
            scrub("npm ERR! ANTHROPIC_API_KEY=sk-ant-api03-AbCd_1234-xyz failed"),
            "npm ERR! ANTHROPIC_API_KEY=sk-ant-*** failed"
        );
        assert_eq!(
            scrub("using sk-proj-0123456789abcdefghij now"),
            "using sk-*** now"
        );
        // Under sixteen characters is a word, not a key, and stays legible.
        assert_eq!(scrub("sk-short"), "sk-short");
        assert_eq!(
            scrub("Authorization: Bearer eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSM"),
            "Authorization: Bearer ***"
        );
        assert_eq!(
            scrub("token eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSM here"),
            "token eyJ*** here"
        );
        assert_eq!(scrub("bearer\tsecret-value"), "Bearer ***");
        // eyJ that is not a JWT is left alone rather than eaten.
        assert_eq!(scrub("eyJnope"), "eyJnope");
        // Multi-byte text is carried through rather than sliced through the middle.
        assert_eq!(scrub("café beareré"), "café beareré");
        // The token runs to the next whitespace, as the mac's `Bearers+S+` does, so a
        // trailing quotation mark goes with it rather than being left behind as a clue.
        assert_eq!(
            scrub("“Bearer abc123” and on"),
            "“Bearer *** and on"
        );
    }

    #[test]
    fn scrubbing_also_strips_nuls_and_caps_the_length() {
        assert_eq!(scrub("  ok\u{0000}ay \n"), "okay");
        let long = "x".repeat(MAX_DISPLAYED_CHARS + 500);
        let scrubbed = scrub(&long);
        assert_eq!(scrubbed.chars().count(), MAX_DISPLAYED_CHARS + 3);
        assert!(scrubbed.ends_with("..."));
    }

}
