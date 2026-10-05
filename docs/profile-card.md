# Show your usage on your GitHub profile

`codeburn card` writes a small SVG card with your AI agent usage: the top tools with their cost, the last 14 days as a sparkline with the peak day, and the period total with calls and cache hit rate. Put it in your profile README and refresh it every night.

```text
ai.agents@month · top 3 ─────────────────────
 claude  ██████████████████████████  $1,467.91
 cursor  ██                          $88.85
 devin   █                           $0.185
 last 14 days ▂▅█▄▄▆▃▃▄▂▅▄▄▂  peak $884/day
 month $1,557 API-equiv · 21,394 calls · 99.4% cache hit
  tracked by CodeBurn
```

## What goes in the card

Only aggregates: tool names, cost totals, daily totals for the last 14 days, the call count and the cache hit rate. No project names, paths, session ids, prompts or model names are written to it. The numbers are the same ones `codeburn report` shows for the period, in your configured currency.

## Flags

| Flag | What it does |
|---|---|
| `-p, --period <period>` | `today`, `week`, `30days` or `month` (default `month`) |
| `--top <n>` | How many tools to list (default 3) |
| `--out <file>` | Write the SVG to a file instead of stdout. Missing folders are created |
| `--theme <theme>` | `auto` (default) follows the viewer's light or dark color scheme; `dark` and `light` are fixed |
| `--provider <provider>` | Only one tool, e.g. `claude` |

The output is self-contained (no fonts or images are loaded) and the same data always gives the same file, so a nightly job only commits when something changed.

## Set it up

1. Create a public repo named after your username, for example `octocat/octocat`. GitHub shows its `README.md` on your profile.
2. Clone it and write the card:

   ```bash
   git clone git@github.com:octocat/octocat.git ~/octocat
   cd ~/octocat
   npx codeburn card --out assets/codeburn-card.svg
   git add assets/codeburn-card.svg && git commit -m "Add CodeBurn card" && git push
   ```

3. Embed it in `README.md`, pinned to the commit you just pushed (`git rev-parse HEAD`):

   ```markdown
   ![AI agent usage](https://raw.githubusercontent.com/octocat/octocat/<commit-sha>/assets/codeburn-card.svg)
   ```

GitHub caches raw images, so a link to `main` can keep showing an old card for a while. Linking by commit hash gives every refresh a new URL. The script below re-pins the link each night.

## Refresh it every night

A GitHub Action cannot do this: your usage data lives on your own machine, not on GitHub. Run it from your machine instead.

Save this as `~/bin/codeburn-card.sh` and make it executable (`chmod +x ~/bin/codeburn-card.sh`). Change the first two lines.

```bash
#!/bin/sh
set -e
REPO="$HOME/octocat"     # your profile repo clone
USER_REPO="octocat/octocat"

cd "$REPO"
git pull -q --rebase
npx -y codeburn card --out assets/codeburn-card.svg
git add assets/codeburn-card.svg
git diff --cached --quiet && exit 0
git commit -q -m "Refresh CodeBurn card"
git push -q

SHA=$(git rev-parse HEAD)
sed -i.bak "s#raw.githubusercontent.com/$USER_REPO/[0-9a-f]\{40\}/assets/codeburn-card.svg#raw.githubusercontent.com/$USER_REPO/$SHA/assets/codeburn-card.svg#" README.md
rm README.md.bak
git commit -q -am "Pin CodeBurn card to $SHA" && git push -q || true
```

`git push` runs unattended, so use an SSH key or a credential helper that does not prompt.

### Linux: cron

Run `crontab -e` and add a line. cron starts with a short `PATH`, so give it the folder that holds `node` and `npx` (`dirname "$(command -v npx)"`).

```cron
0 3 * * * PATH=/usr/local/bin:/usr/bin:/bin $HOME/bin/codeburn-card.sh >> $HOME/.codeburn-card.log 2>&1
```

### macOS: launchd

Save as `~/Library/LaunchAgents/app.codeburn.card.plist`, with your home folder and the folder that holds `npx` (`/opt/homebrew/bin` on Apple silicon with Homebrew):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.codeburn.card</string>
  <key>ProgramArguments</key>
  <array><string>/Users/you/bin/codeburn-card.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/Users/you/.codeburn-card.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.codeburn-card.log</string>
</dict>
</plist>
```

Load it with `launchctl load ~/Library/LaunchAgents/app.codeburn.card.plist`. A job that was due while the Mac slept runs when it wakes.
