# Menu bar, tray, and Capacity Dock

## macOS

```bash
codeburn menubar
```

One command: downloads the latest `.app`, installs it, and launches it. A copy you already have is replaced where it lives, in `/Applications` or `~/Applications`, so you never end up with two bundles and two login items; if that folder cannot be written to, the install goes to `~/Applications` and names the old copy for you to move to the Trash. Re-run with `--force` to reinstall. Launching the app retires the copy already running, so there is only ever one flame in the menu bar. You can also install and manage it from the desktop app's Plugins page. The native Swift and SwiftUI app lives in `mac/` (see `mac/README.md` for build details).

The menubar icon shows the spend period selected in Settings (Today by default; Week, Month, and 6 Months are also available). Non-today periods add a short suffix such as `$42 / mo` so the menu bar value stays clear. Click to open a popover with agent tabs, period switcher (Today, 7 Days, 30 Days, Month, All), Trend, Forecast, Pulse, Stats, and Plan insights, activity and model breakdowns, optimize findings, and CSV/JSON export. Refreshes every 30 seconds.

You can also set the menubar status period from Terminal:

```bash
defaults write org.agentseal.codeburn-menubar CodeBurnMenubarPeriod -string month
```

Allowed values are `today`, `week`, `month`, and `sixMonths`. Relaunch the app to apply external defaults changes.

**Compact mode** shrinks the menubar item to fit the text, dropping decimals (e.g. `$110` instead of `$110.20`):

```bash
defaults write org.agentseal.codeburn-menubar CodeBurnMenubarCompact -bool true
```

Relaunch the app to apply. To revert: `defaults delete org.agentseal.codeburn-menubar CodeBurnMenubarCompact`.

**Second row** adds an optional smaller line under the menubar figure. Turn it on in Settings → General → Display and pick what it shows: quota remaining with its reset countdown (for whichever connected provider is nearest its limit), today's cost, today's tokens, or running sessions. It is off by default, and the line hides itself while the chosen metric has no data, so the item falls back to its single-row figure. From Terminal:

```bash
defaults write org.agentseal.codeburn-menubar CodeBurnMenubarSecondRowEnabled -bool true
defaults write org.agentseal.codeburn-menubar CodeBurnMenubarSecondRowMetric -string todayCost
```

Allowed metric values are `quotaRemaining`, `todayCost`, `todayTokens`, and `activeSessions`. Relaunch the app to apply external defaults changes.

**Refresh cadence** is set in Settings under Usage Refresh. Auto (the default) refreshes every 30 seconds on AC power and backs off on battery, in Low Power Mode, and while the display sleeps; fixed 1, 5, or 15 minute cadences and a Manual mode (refresh only when you open the popover or click Refresh Now) are also available. From Terminal:

```bash
defaults write org.agentseal.codeburn-menubar CodeBurnMenubarRefreshSeconds -int 300
```

Seconds between refreshes: `60`, `300`, or `900`; `0` is Manual and `-1` is Auto. Takes effect on the next refresh tick, no relaunch needed.

**Preferred terminal** decides where Full Report and Optimize open. Set it in Settings → General → Terminal, or from Terminal:

```bash
defaults write org.agentseal.codeburn-menubar CodeBurnPreferredTerminal -string iterm2
```

Allowed values are `terminal` (macOS Terminal.app, the default) and `iterm2`. Anything else falls back to `terminal`. Only terminals that can script a command into a live window are offered; if the chosen app is missing or fails to accept the command, CodeBurn tries Terminal.app and then runs the command in the background, logging each step to Console.app. Takes effect on the next launch of a command, no relaunch needed.

## Windows

The recommended install is the [Microsoft Store](https://apps.microsoft.com/detail/9P0R4ZL5XMB8) (Store ID `9P0R4ZL5XMB8`), which ships the desktop app with the tray app inside it. Microsoft signs that package at submission, and the Store keeps it up to date, so the tray app leaves its own update checker switched off there.

Windows gets the same ambient view from the system tray, from the same one command:

```powershell
codeburn menubar
```

It downloads the `.msi` for your CLI version, verifies its sha256, runs it through `msiexec /passive`, and launches the tray app. Re-run with `--force` to reinstall; an already-installed matching version is just launched. You can also download the `.msi` yourself from the [latest Windows Menubar release](https://github.com/getagentseal/codeburn/releases/tag/windows-v0.9.25).

Today's spend sits in the tray as a number beside the flame icon (turn it off in Settings, and the tooltip always carries it). Click for the same popover the macOS app shows: agent tabs, period switcher, Trend, Forecast, Pulse, Stats and Plan insights, activity and model breakdowns, optimize findings, and CSV/JSON export. Settings covers launch at login, the tray number, theme, and currency. It refreshes every 60 seconds while the popover is open and every 2 minutes while it is closed.

Turn on **Show Capacity Dock** in the tray menu, or from the desktop app, for the same edge-docked quota rail the macOS menubar has: one ring per connected provider, hover for every quota window with its reset time, drag it to any screen edge. It is off by default and needs codeburn 0.9.24 or newer for `codeburn quota`.

The desktop app installs and configures the tray companion from a card on its **Plugins** page, the way it does the macOS menu bar: Install, Update, Open, Settings, Quit and Uninstall, a Running dot with the installed version, and the Capacity Dock switch. `codeburn menubar --uninstall` removes it from the command line.

The tray app reads everything through the CLI, so install that first (`npm install -g codeburn`). It needs **codeburn 0.9.9 or newer**, and shows a setup screen with the install command until it finds one. Source and build instructions are in [`windows/`](../windows/) ([windows/DEVELOPMENT.md](../windows/DEVELOPMENT.md)).

The `.msi` under the `windows-v*` releases and the desktop setup `.exe` are a developer preview. Both are unsigned, so SmartScreen prompts on first run: click "More info", then "Run anyway". The preview builds also do not update themselves. The tray app still tells you when a newer version exists and links to the release; taking it means re-running `codeburn menubar --force` or downloading the new build yourself.

### WSL

Agents you run *inside* a WSL distro write their history to the distro's Linux home, not to your Windows user profile, so a Windows-only scan reports nothing for them. CodeBurn on Windows now also scans each WSL distro's home directories (`\\wsl$\<distro>\home\*` and `\\wsl$\<distro>\root`) for Claude Code (`~/.claude`) and Codex (`~/.codex`) history, merging what it finds with your Windows sessions. It is read-only, and the tray app inherits it — it reads everything through the CLI.

Only **running** distros are scanned by default: reaching into `\\wsl$\<distro>` boots a stopped distro, which CodeBurn will not do behind your back. Start the distro (or set `CODEBURN_WSL=all`) if you want the others included. Stopping a distro does not lose its numbers — an offline root is not a deleted transcript, so its usage keeps counting and comes straight back out of the cache when you start it again. When that home is reachable, an ordinary transcript actually deleted there is evicted normally instead of being mistaken for an offline root; Claude rows carrying PR attribution keep the existing historical-retention exception. `codeburn doctor` lists every root it probed, WSL ones included, and says so in one line when it probed none.

| Value | Behaviour |
| --- | --- |
| `CODEBURN_WSL=running` | Default. Scans running distros only. |
| `CODEBURN_WSL=all` | Scans every installed distro, starting stopped ones on first access. |
| `CODEBURN_WSL=off` | Disables WSL discovery and UNC access immediately; `wsl.exe` is never run. Historical usage already in CodeBurn's cache remains reportable and is reused if discovery is re-enabled. |

## Linux (GNOME)

Linux gets the same ambient view through a GNOME Shell extension (GNOME 45+): spend in the top panel, period switcher, compact mode, and daily budget alerts. It lives in [`gnome/`](../gnome/):

```bash
git clone https://github.com/getagentseal/codeburn && cd codeburn/gnome
./install.sh
gnome-extensions enable codeburn@codeburn.dev
```

See [gnome/README.md](../gnome/README.md) for settings and development notes. The Tauri tray app in `windows/` also builds and runs on Linux, but it is experimental and unreleased there — the GNOME extension is the supported Linux surface.

