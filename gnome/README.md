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
| Refresh Interval | 30s | Background tick interval. Raised to the power floor (120s on AC, 150s on battery, 300s in power saver), so it only takes effect when slower. See [Refresh cadence](#refresh-cadence). |
| Default Period | Today | Period shown on open |
| Default Scope | This device | Show this device or all paired devices on open |
| Compact Mode | Off | Hide cost label, show icon only |
| Budget Threshold | $0 | Daily budget alert (0 = disabled) |
| Budget Alerts | Off | Show warning when budget exceeded |
| CLI Path | (auto) | Custom path to `codeburn` binary |

## Refresh cadence

Opening the menu fetches fresh data from the CLI right away.

While the menu is closed, a background tick runs at the power floor below, or at the Refresh Interval setting if that is slower:

| Power state | Tick interval |
| --- | --- |
| AC (or UPower unavailable) | 120s |
| On battery (UPower `OnBattery`) | 150s |
| Power saver (power-profiles `power-saver`) | 300s |

A tick does not force a CLI run. It reuses the last payload while it is less than 5 minutes old, the same cache that period and provider switches use, so idle polling spawns the CLI at most about once every 5 minutes. The refresh button always fetches.

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
