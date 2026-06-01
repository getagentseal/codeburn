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

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Refresh Interval | 30s | How often to poll CodeBurn CLI |
| Default Period | Today | Period shown on open (Today, 7 Days, 30 Days, Month, 6 Months, Lifetime) |
| Compact Mode | Off | Hide cost label, show icon only |
| Budget Threshold | $0 | Daily budget alert (0 = disabled) |
| Budget Alerts | Off | Show warning when budget exceeded |
| CLI Path | (auto) | Custom path to `codeburn` binary |

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
