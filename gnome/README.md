# CodeBurn GNOME Extension

Monitor AI coding assistant token usage and costs from your GNOME desktop panel.

## Requirements

- GNOME Shell 45 or later
- CodeBurn CLI installed (`npm i -g codeburn`)
- `glib-compile-schemas` (usually part of `glib2-devel` or `libglib2.0-dev`)

## Install

```bash
cd gnome
chmod +x install.sh
./install.sh
```

Then restart GNOME Shell:
- **Wayland:** Log out and back in
- **X11:** Press `Alt+F2`, type `r`, press Enter

Enable the extension:

```bash
gnome-extensions enable codeburn@codeburn.dev
```

## Configure

Open preferences:

```bash
gnome-extensions prefs codeburn@codeburn.dev
```

Or use the GNOME Extensions app.

### Combined devices

The **All devices** scope uses CodeBurn's existing local pairing. On another
machine, run `codeburn share --always`, then pair it from this machine with
`codeburn devices add`. The extension will include reachable paired devices in
the combined total; sleeping or unavailable devices remain visible as
unavailable rather than being counted.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Refresh Interval | 30s | Fastest poll while the menu is open or a session is working. See [Refresh cadence](#refresh-cadence). |
| Default Period | Today | Period shown on open |
| Default Scope | This device | Show this device or all paired devices on open |
| Compact Mode | Off | Hide cost label, show icon only |
| Budget Threshold | $0 | Daily budget alert (0 = disabled) |
| Budget Alerts | Off | Show warning when budget exceeded |
| CLI Path | (auto) | Custom path to `codeburn` binary |

## Refresh cadence

Background polling follows the macOS menubar (`RefreshCadence` in `mac/Sources/CodeBurnMenubar/RefreshCadence.swift`), not a fixed timer.

| State | Next CLI poll |
| --- | --- |
| Menu open, or a live session still working | The Refresh Interval setting, capped at 30s. A shorter setting is kept. |
| Menu closed and no working session, on AC | At least 120s, or the setting if it is already slower |
| On battery | At least 150s |
| Power saver | At least 300s |

Opening the menu fetches immediately. A session counts as working when its `idleSeconds` is at most 120 (the menubar's live-session threshold). A payload with no `liveSessions` block does not count as active.

The panel keeps polling while the session is locked or you are away. Only the interval changes. It does not pause when the screen sleeps. A machine that does not answer UPower stays on the AC intervals, which is the extension's previous behavior of not adding a battery penalty it cannot see.

The macOS menubar also arms a nap backstop (every 180s, with 60s of tolerance) because App Nap can defer its timer. GNOME Shell does not nap this extension, so that backstop is not scheduled. The same numbers live in `refreshCadence.js` next to the decision.

The CLI dashboard's `--refresh` flag is a separate control and will not run faster than 60 seconds. The panel uses the menubar intervals above. Period and provider switches still reuse the last payload for up to 5 minutes; a cadence tick does not.

## Uninstall

```bash
gnome-extensions disable codeburn@codeburn.dev
rm -r ~/.local/share/gnome-shell/extensions/codeburn@codeburn.dev
```

## Development

Test changes without installing:

```bash
# Compile schemas locally
glib-compile-schemas schemas/

# Symlink for development
ln -sf "$(pwd)" ~/.local/share/gnome-shell/extensions/codeburn@codeburn.dev

# Watch logs
journalctl -f -o cat /usr/bin/gnome-shell
```
