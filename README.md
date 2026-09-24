<table align="center">
  <tr>
    <td align="center" valign="middle">
      <a href="https://claude.com/open-source-max"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/open-source-recipient.png" alt="Codex and Claude for Open Source Recipient" width="520" /></a>
    </td>
    <td align="center" valign="middle">
      <a href="https://www.producthunt.com/products/codeburn?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-codeburn-2" target="_blank" rel="noopener noreferrer"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1220451&theme=dark&t=1786459783669" alt="CodeBurn - See where your AI coding spend actually goes | Product Hunt" width="250" height="54" /></a>
    </td>
  </tr>
</table>

<p align="center">
  <img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers.png" alt="CodeBurn" width="420" />
</p>

<p align="center"><strong>See where your AI spend goes.</strong></p>

<p align="center">
    <a href="https://www.npmjs.com/package/codeburn"><img src="https://img.shields.io/npm/v/codeburn.svg?color=F97316" alt="npm version" /></a>
    <a href="https://www.npmjs.com/package/codeburn"><img src="https://img.shields.io/npm/dt/codeburn.svg?color=F97316" alt="total downloads" /></a>
    <a href="https://github.com/getagentseal/codeburn/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/codeburn.svg?color=F97316" alt="license" /></a>
    <a href="https://github.com/getagentseal/codeburn"><img src="https://img.shields.io/badge/node-%3E%3D22-F97316.svg" alt="node version" /></a>
    <a href="https://discord.gg/w2sw8mCqep"><img src="https://img.shields.io/badge/discord-join-F97316?logo=discord&logoColor=white" alt="Discord" /></a>
    <a href="https://x.com/_codeburn"><img src="https://img.shields.io/badge/%40__codeburn-F97316?logo=x&logoColor=white" alt="Follow @_codeburn on X" /></a>
    <a href="https://github.com/sponsors/iamtoruk"><img src="https://img.shields.io/badge/sponsor-♥-F97316?logo=github" alt="Sponsor" /></a>
</p>

<p align="center">If CodeBurn shows you something your bill never did, <a href="https://github.com/getagentseal/codeburn/stargazers">star the repo</a> so other developers find it, and consider <a href="https://github.com/sponsors/iamtoruk">sponsoring</a> to keep 41 integrations honest.</p>

<p align="center"><code>npx codeburn</code></p>

<p align="center"><sub>To keep it: <code>npm install -g codeburn</code> or <code>brew install codeburn</code>. Needs Node.js 22.13+.</sub></p>

<p align="center">
  <a href="https://github.com/getagentseal/codeburn/releases/download/desktop-v0.9.25/CodeBurn-0.9.25-arm64.dmg"><img src="https://img.shields.io/badge/macOS-Apple_Silicon-F97316?logo=apple&logoColor=white" alt="Download CodeBurn for macOS (Apple Silicon)" /></a>
  <a href="https://github.com/getagentseal/codeburn/releases/download/desktop-v0.9.25/CodeBurn-0.9.25.dmg"><img src="https://img.shields.io/badge/macOS-Intel-F97316?logo=apple&logoColor=white" alt="Download CodeBurn for macOS (Intel)" /></a>
  <a href="https://apps.microsoft.com/detail/9P0R4ZL5XMB8"><img src="https://img.shields.io/badge/Windows-Microsoft_Store-F97316?logo=microsoft&logoColor=white" alt="Get CodeBurn from the Microsoft Store" /></a>
  <a href="https://github.com/getagentseal/codeburn/releases/download/desktop-v0.9.25/CodeBurn-Setup-0.9.25.exe"><img src="https://img.shields.io/badge/Windows-.exe-F97316?logo=windows&logoColor=white" alt="Download the CodeBurn Windows installer (.exe)" /></a>
  <a href="https://github.com/getagentseal/codeburn/releases/download/desktop-v0.9.25/codeburn-desktop_0.9.25_amd64.deb"><img src="https://img.shields.io/badge/Linux-.deb-F97316?logo=debian&logoColor=white" alt="Download CodeBurn for Linux (.deb)" /></a>
  <a href="https://github.com/getagentseal/codeburn/releases/download/desktop-v0.9.25/codeburn-desktop-0.9.25.x86_64.rpm"><img src="https://img.shields.io/badge/Linux-.rpm-F97316?logo=redhat&logoColor=white" alt="Download CodeBurn for Linux (.rpm)" /></a>
  <a href="https://github.com/getagentseal/codeburn/releases/download/desktop-v0.9.25/CodeBurn-0.9.25.AppImage"><img src="https://img.shields.io/badge/Linux-AppImage-F97316?logo=linux&logoColor=white" alt="Download CodeBurn for Linux (AppImage)" /></a>
</p>

<p align="center"><sub>Desktop app 0.9.25. The macOS builds are signed with a Developer ID and notarized by Apple.</sub></p>

## The problem

Your bill gives you a month total. It does not break that down by project, by model or by task, and it does not show which part of it was wasted.

Claude Code, Codex, Cursor and the rest each write a session file every time you use them, and those files hold every token and every model call. CodeBurn reads those files and produces the breakdown.

<p align="center">
  <img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/readme/all-surfaces.png" alt="CodeBurn on macOS: the desktop app Overview, the menu bar popover, the Capacity Dock rail on the screen edge, and the Claude glance card, all open at once" />
</p>

<p align="center"><sub>Desktop app, macOS menu bar, Capacity Dock and the Claude glance card, one engine behind all of them.</sub></p>

## Sixty seconds

```bash
npx codeburn
```

There is no account and no sign-up. CodeBurn looks in the folders your tools already write to, prices every token, and prints what you spent.

Under the total are the tables: cost by tool, by model, by project and by task. Task means what the agent was doing, such as coding, debugging or planning, worked out from the session itself.

Arrow keys move the period, from today out to your whole history. Press <kbd>p</kbd> to switch between tools. Press <kbd>q</kbd> to quit.

<p align="center">
  <img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/readme/terminal.png" alt="The codeburn terminal dashboard: today's cost, per-model and per-project tables, and a daily activity chart" />
</p>

## See it

The desktop app is the same data with room to move around in. It opens on today: what you have spent, what the month is on pace to cost, and the last thirty days day by day.

One click from the clock, the menu bar popover shows the short version of that page. The Capacity Dock adds a ring per provider at the screen edge. Hover a ring and a glance card tells you what is running right now and which limits are filling up.

All four read the same files on your disk, so they show the same numbers, allowing for when each one last refreshed.

The same numbers are in your browser with `codeburn web`, and in the terminal with `codeburn`.

## Understand it

Every number in the app is clickable. Click today's total and you land on Sessions, one row per session with its project, its model, its tokens and its cost. Click a row and you get the turns inside it, so you can see which part of the work was expensive.

On the Spend page the same money is cut four ways, by project, by git branch, by model and by task. The branch view adds up every session you ran while you were on that branch, so you get the cost of a feature.

Compare periods puts two date ranges side by side and shows the difference. Use it after you change something, a model or a workflow or a prompt, to find out whether the change actually cost less.

The Pull requests page matches spend against the pull requests your sessions recorded, so you can see which spend shipped ([Yield](docs/yield.md)).

## Fix it

```bash
codeburn optimize
```

Optimize reads your sessions and your config, then lists what costs tokens without earning them. A file the agent re-reads on every turn. An MCP server you installed months ago and never call. A `CLAUDE.md` that grew long enough to ride along in every single request.

Each finding comes with a grade, the fix, and what that fix should save you over the period it scanned.

<p align="center">
  <img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/readme/optimize.png" alt="CodeBurn Optimize: a setup health grade with findings, estimated savings, and the fix for each one" />
</p>

CodeBurn can make the config changes for you, and take them back:

```bash
codeburn optimize --apply   # review and apply
codeburn act undo --last    # put it back
```

Files are backed up before they are changed, and you see the change before anything is applied. A few days later, `codeburn act report` checks what each fix promised against what your sessions actually did, including the fixes that changed nothing.

## Stay ahead

```bash
codeburn plan set claude-max   # the plan you pay for
codeburn quota                 # how much of it is left
codeburn guard install         # spending caps for Claude Code
```

Tell CodeBurn which subscription you pay for and it stops showing only what you spent. It shows how much of the plan you have used, and whether the month is on pace to run past it.

`codeburn quota` reads the live limits out of the tools you are already signed in to. That is where the five-hour and weekly windows come from. Check it before a long run.

Guard is opt-in and local. `codeburn guard install` adds Claude Code hooks that warn a session once it passes $5 and stop it at $15. Both numbers are yours to change, `codeburn guard status` shows where the hooks live, and `codeburn guard uninstall` takes them out again.

## Always in view

Today's spend sits in the macOS menu bar, beside the clock. Click it and the popover opens on the same figures as the app, with today, the period switcher, the trend and the per-model breakdown.

The Capacity Dock docks a thin rail to any edge of your screen, with one ring per provider showing how much of that plan is left. It shows what is left before you start a run, not after.

Turn either on from the desktop app's Plugins page in one click, or from the command line:

```bash
codeburn menubar
```

On Linux the same view lives in the top panel, as a GNOME Shell extension.

The desktop app runs on Windows. Install it from the [Microsoft Store](https://apps.microsoft.com/detail/9P0R4ZL5XMB8), which is the recommended way and keeps itself up to date, or take the [direct installer](https://github.com/getagentseal/codeburn/releases/download/desktop-v0.9.25/CodeBurn-Setup-0.9.25.exe). The Windows tray app shows today's cost next to the clock, the same way the macOS menu bar does, and clicking it opens the same popover. The Capacity Dock is there too, from the tray menu or the app's Plugins page. If you run your agents inside WSL, CodeBurn reads the distro's home directory as well as your Windows profile, so sessions you ran in Linux are counted without you installing anything twice.

Setup for all three platforms, including WSL, is in [Menu bar and tray](docs/menubar.md).

## Inside your agent

```bash
claude mcp add codeburn -- npx -y codeburn mcp
```

That registers a local MCP server over stdio. Your agent can then answer "where did my tokens go this week" or "what should I change to spend less" without you leaving the conversation.

It reads the same files on disk that the CLI reads. The server answers from that local data and makes no network call of its own, and project names are pseudonymized unless the agent asks for them.

## Works with 40 tools

CodeBurn detects the tools you already use. There is nothing to configure and no folder to point it at. If a tool is installed and has sessions on disk, it shows up. Each logo links to that tool's page.

<p align="center">
  <a href="docs/providers/claude.md" title="Claude Code &amp; Claude Desktop"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/claude.jpg" alt="Claude Code &amp; Claude Desktop" height="34" /></a>
  <a href="docs/providers/cline.md" title="Cline"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/cline.svg" alt="Cline" height="34" /></a>
  <a href="docs/providers/codewhale.md" title="CodeWhale"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/codewhale.svg" alt="CodeWhale" height="34" /></a>
  <a href="docs/providers/codex.md" title="Codex (OpenAI)"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/codex.png" alt="Codex (OpenAI)" height="34" /></a>
  <a href="docs/providers/cursor.md" title="Cursor"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/cursor.jpg" alt="Cursor" height="34" /></a>
  <a href="docs/providers/cursor-agent.md" title="cursor-agent"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/cursor-agent.jpg" alt="cursor-agent" height="34" /></a>
  <a href="docs/providers/devin.md" title="Devin"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/devin.png" alt="Devin" height="34" /></a>
  <a href="docs/providers/forge.md" title="Forge"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/forge.png" alt="Forge" height="34" /></a>
  <a href="docs/providers/gemini.md" title="Gemini CLI"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/gemini.png" alt="Gemini CLI" height="34" /></a>
  <a href="docs/providers/mistral-vibe.md" title="Mistral Vibe"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/mistral-vibe.svg" alt="Mistral Vibe" height="34" /></a>
  <a href="docs/providers/copilot.md" title="GitHub Copilot"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/copilot.jpg" alt="GitHub Copilot" height="34" /></a>
  <a href="docs/providers/ibm-bob.md" title="IBM Bob"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/ibm-bob.svg" alt="IBM Bob" height="34" /></a>
  <a href="docs/providers/kiro.md" title="Kiro"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/kiro.png" alt="Kiro" height="34" /></a>
  <a href="docs/providers/opencode.md" title="OpenCode"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/opencode.png" alt="OpenCode" height="34" /></a>
  <a href="docs/providers/openclaw.md" title="OpenClaw"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/openclaw.jpg" alt="OpenClaw" height="34" /></a>
  <a href="docs/providers/pi.md" title="Pi"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/pi.png" alt="Pi" height="34" /></a>
  <a href="docs/providers/omp.md" title="OMP (Oh My Pi)"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/omp.svg" alt="OMP (Oh My Pi)" height="34" /></a>
  <a href="docs/providers/droid.md" title="Droid"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/droid.png" alt="Droid" height="34" /></a>
  <a href="docs/providers/kilo-code.md" title="KiloCode"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/kilo-code.png" alt="KiloCode" height="34" /></a>
  <a href="docs/providers/qwen.md" title="Qwen"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/qwen.png" alt="Qwen" height="34" /></a>
  <a href="docs/providers/kimi.md" title="Kimi Code CLI"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/kimi.svg" alt="Kimi Code CLI" height="34" /></a>
  <a href="docs/providers/lingtai-tui.md" title="LingTai TUI">LingTai TUI</a>
  <a href="docs/providers/goose.md" title="Goose"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/goose.png" alt="Goose" height="34" /></a>
  <a href="docs/providers/antigravity.md" title="Antigravity"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/antigravity.png" alt="Antigravity" height="34" /></a>
  <a href="docs/providers/crush.md" title="Crush"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/crush.png" alt="Crush" height="34" /></a>
  <a href="docs/providers/warp.md" title="Warp"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/warp.jpg" alt="Warp" height="34" /></a>
  <a href="docs/providers/mux.md" title="Mux (coder)"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/mux.png" alt="Mux (coder)" height="34" /></a>
  <a href="docs/providers/vercel-gateway.md" title="Vercel AI Gateway"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/vercel-gateway.png" alt="Vercel AI Gateway" height="34" /></a>
  <a href="docs/providers/zerostack.md" title="Zerostack"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/zerostack.png" alt="Zerostack" height="34" /></a>
  <a href="docs/providers/grok.md" title="Grok Build"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/grok.png" alt="Grok Build" height="34" /></a>
  <a href="docs/providers/grokbot.md" title="Grok Bot"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/grok.png" alt="Grok Bot" height="34" /></a>
  <a href="docs/providers/zcode.md" title="ZCode"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/zcode.jpg" alt="ZCode" height="34" /></a>
  <a href="docs/providers/zed.md" title="Zed"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/zed.jpg" alt="Zed" height="34" /></a>
  <a href="docs/providers/hermes.md" title="Hermes Agent"><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers/hermes.png" alt="Hermes Agent" height="34" /></a>
</p>

<details>
<summary><strong>All 40 tools</strong></summary>

Each page lists where that tool keeps its data, the format it uses, and the quirks CodeBurn works around.

[Antigravity](docs/providers/antigravity.md) &middot; [Claude Code](docs/providers/claude.md) &middot; [Cline](docs/providers/cline.md) &middot; [Cline CLI](docs/providers/cline-cli.md) &middot; [Codebuff](docs/providers/codebuff.md) &middot; [Codex](docs/providers/codex.md) &middot;
[CodeWhale](docs/providers/codewhale.md) &middot; [Copilot](docs/providers/copilot.md) &middot; [Crush](docs/providers/crush.md) &middot; [Cursor](docs/providers/cursor.md) &middot; [Cursor Agent](docs/providers/cursor-agent.md) &middot; [DeepSeek Harness](docs/providers/dsh.md) &middot;
[Devin](docs/providers/devin.md) &middot; [Droid](docs/providers/droid.md) &middot; [Forge](docs/providers/forge.md) &middot; [Gemini CLI](docs/providers/gemini.md) &middot; [Goose](docs/providers/goose.md) &middot; [Grok Bot](docs/providers/grokbot.md) &middot;
[Grok Build](docs/providers/grok.md) &middot; [Hermes Agent](docs/providers/hermes.md) &middot; [IBM Bob](docs/providers/ibm-bob.md) &middot; [KiloCode](docs/providers/kilo-code.md) &middot; [Kimi](docs/providers/kimi.md) &middot; [Kimi Code](docs/providers/kimicode.md) &middot;
[Kiro](docs/providers/kiro.md) &middot; [LingTai TUI](docs/providers/lingtai-tui.md) &middot; [Mistral Vibe](docs/providers/mistral-vibe.md) &middot; [Mux](docs/providers/mux.md) &middot; [OMP](docs/providers/omp.md) &middot; [Open Design](docs/providers/open-design.md) &middot;
[OpenClaude](docs/providers/openclaude.md) &middot; [OpenClaw](docs/providers/openclaw.md) &middot; [OpenCode](docs/providers/opencode.md) &middot; [Pi](docs/providers/pi.md) &middot; [Qwen](docs/providers/qwen.md) &middot; [Quick Desktop](docs/providers/quickdesk.md) &middot;
[Warp](docs/providers/warp.md) &middot; [ZCode](docs/providers/zcode.md) &middot; [Zed](docs/providers/zed.md) &middot; [Zerostack](docs/providers/zerostack.md)

CodeBurn also reads the [Vercel AI Gateway](docs/providers/vercel-gateway.md) reporting API, which is a gateway rather than a tool, so its spend is shown on its own row and left out of your totals by default.

If several of these have sessions on disk, press <kbd>p</kbd> in the dashboard to move between them. A path that has changed is worth [an issue](https://github.com/getagentseal/codeburn/issues). Adding a tool is a single file: see `src/providers/codex.ts`.

</details>

## Private by design

CodeBurn reads files that are already on your disk. There is no account, no API key and no proxy in front of your agent.

Your prompts, your code and your project names stay on your computer. CodeBurn does not sit between you and your agent, so if it stopped working tomorrow your tools would not notice.

Prices come from [LiteLLM](https://github.com/BerriAI/litellm) and refresh once a day.

## Built in the open

MIT licensed. Development happens in this repo.

<p align="center"><sub>Starred by developers at</sub></p>

<p align="center">
  <img src="https://img.shields.io/badge/Red%20Hat-1f1f1f?style=flat&logo=redhat&logoColor=white" alt="Red Hat" />
  <img src="https://img.shields.io/badge/Microsoft-1f1f1f?style=flat" alt="Microsoft" />
  <img src="https://img.shields.io/badge/Amazon%20Web%20Services-1f1f1f?style=flat" alt="Amazon Web Services" />
  <img src="https://img.shields.io/badge/Alibaba-1f1f1f?style=flat" alt="Alibaba" />
  <img src="https://img.shields.io/badge/IBM-1f1f1f?style=flat" alt="IBM" />
  <img src="https://img.shields.io/badge/Google-1f1f1f?style=flat&logo=google&logoColor=white" alt="Google" />
  <img src="https://img.shields.io/badge/SAP-1f1f1f?style=flat&logo=sap&logoColor=white" alt="SAP" />
  <img src="https://img.shields.io/badge/Samsung-1f1f1f?style=flat&logo=samsung&logoColor=white" alt="Samsung" />
  <img src="https://img.shields.io/badge/Tencent-1f1f1f?style=flat" alt="Tencent" />
  <img src="https://img.shields.io/badge/Adobe-1f1f1f?style=flat" alt="Adobe" />
  <img src="https://img.shields.io/badge/Accenture-1f1f1f?style=flat&logo=accenture&logoColor=white" alt="Accenture" />
  <img src="https://img.shields.io/badge/Zalando-1f1f1f?style=flat&logo=zalando&logoColor=white" alt="Zalando" />
  <img src="https://img.shields.io/badge/Apple-1f1f1f?style=flat&logo=apple&logoColor=white" alt="Apple" />
  <img src="https://img.shields.io/badge/ByteDance-1f1f1f?style=flat&logo=bytedance&logoColor=white" alt="ByteDance" />
  <img src="https://img.shields.io/badge/Bosch-1f1f1f?style=flat&logo=bosch&logoColor=white" alt="Bosch" />
  <img src="https://img.shields.io/badge/Kakao-1f1f1f?style=flat&logo=kakao&logoColor=white" alt="Kakao" />
  <img src="https://img.shields.io/badge/Delivery%20Hero-1f1f1f?style=flat" alt="Delivery Hero" />
  <img src="https://img.shields.io/badge/Oracle-1f1f1f?style=flat" alt="Oracle" />
  <img src="https://img.shields.io/badge/Siemens-1f1f1f?style=flat&logo=siemens&logoColor=white" alt="Siemens" />
  <img src="https://img.shields.io/badge/NVIDIA-1f1f1f?style=flat&logo=nvidia&logoColor=white" alt="NVIDIA" />
  <img src="https://img.shields.io/badge/Baidu-1f1f1f?style=flat&logo=baidu&logoColor=white" alt="Baidu" />
  <img src="https://img.shields.io/badge/Mercedes--Benz-1f1f1f?style=flat" alt="Mercedes-Benz" />
  <img src="https://img.shields.io/badge/Walmart-1f1f1f?style=flat" alt="Walmart" />
  <img src="https://img.shields.io/badge/Salesforce-1f1f1f?style=flat" alt="Salesforce" />
</p>

<p align="center"><sub>Keeping 41 integrations working takes constant time. The tools underneath change often, and each change means a config path to follow or a stored format to relearn. Sponsorship pays for that work.</sub></p>

<p align="center">
  <a href="https://github.com/sponsors/iamtoruk"><img src="https://img.shields.io/badge/Sponsor_CodeBurn-%E2%99%A5-F97316?style=for-the-badge&logo=github&labelColor=1a1a1a" alt="Sponsor CodeBurn" /></a>
</p>

<p align="center"><sub>Companies sponsor at <a href="https://github.com/sponsors/iamtoruk">Bronze, Silver or Gold</a>. Your logo goes in a sponsors block in this section, separate from the stargazer badges above. Silver and Gold also put it on <a href="https://codeburn.app">codeburn.app</a>. Gold puts it at the top of this README as well, and issues your team files get triaged first. The first company sponsor has the space to itself until the next one shows up.</sub></p>

<a href="https://www.star-history.com/?repos=getagentseal%2Fcodeburn&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=getagentseal/codeburn&type=date&theme=dark&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=getagentseal/codeburn&type=date&legend=top-left" />
 </picture>
</a>

## The manual

| Page | What is in it |
|---|---|
| [Commands](docs/cli.md) | Every command, every flag, every keyboard shortcut |
| [How it works](docs/how-it-works.md) | Pricing, task categories, and where each tool keeps its data |
| [Optimize](docs/optimize.md) | What is scanned, what `--apply` writes, how to read the grade |
| [Menu bar and tray](docs/menubar.md) | macOS, Windows (including WSL), and the Linux GNOME extension |
| [Plans and quota](docs/plans-and-quota.md) | Subscription tracking and live provider limits |
| [Guard](docs/guard.md) | Budget caps for Claude Code |
| [Web dashboard](docs/web.md) | The browser view, and combining usage across your devices |
| [Yield](docs/yield.md) | Which spend actually shipped, correlated against git |
| [MCP](docs/mcp.md) | The local MCP server and its two tools |
| [Configuration](docs/configuration.md) | Currency, model aliases, price overrides, environment variables |
| [Tools](docs/providers/README.md) | One page per tool: data location, format, known quirks |
| [All docs](docs/README.md) | The full index |

## Questions

**My spend**

<details>
<summary><strong>I know what the month cost. How much of it was wasted, and how would I know?</strong></summary>

Run `codeburn optimize`. It reads the last 30 days of sessions and your `~/.claude/` config, lists what cost tokens without earning them, and prints a Potential savings line in tokens and dollars for the period it scanned. Findings come in three groups: Fix now, which CodeBurn can apply for you, Habits, which is how you drive the next session, and FYI, which may well be money well spent. Each finding says whether its number is measured from your own token counts or modelled from an average. The setup gets a grade from A to F, and that grade rates the config, not the spending, so an expensive month with a clean setup still scores an A. See [Optimize](docs/optimize.md).

</details>

<details>
<summary><strong>Which sessions burn the most, and why?</strong></summary>

The desktop Overview and the terminal dashboard both list the five most expensive sessions. Click one in the app and you land on Sessions with the drawer open on it: project, models, tokens, and the per-model, per-category, per-branch and per-day split of that one session. `codeburn sessions` is the same list in the terminal. `codeburn optimize` flags sessions that cost more than twice their own project's average. The drawer usually shows the cause, such as one model doing most of the work or one category taking most of the turns. See [Drill-through](docs/drill-through.md).

</details>

<details>
<summary><strong>My agent spent an hour on a five-minute task. Where did the money go?</strong></summary>

Open that session in the Sessions drawer for the per-turn cost, then run `codeburn context` and pick it from the list. `codeburn context` prints what filled the context window: `assistant` split into text, reasoning and tool calls with a row per tool, `user` split into text, images and compaction summaries, and `tool` with the `tool-result` total, which is usually the biggest line. It also counts how many compactions happened, which is the usual sign of an hour spent re-reading. The block sizes are estimated from character counts. The exact context figure comes from the last call's reported usage, and the output labels it as such.

</details>

<details>
<summary><strong>Is Opus worth it, or would Sonnet have done the same job?</strong></summary>

Run `codeburn compare`, or press `c` in the dashboard, to put two models side by side on your own history: one-shot rate, retry rate, self-correction, cost per call, cost per edit, cache hit rate. Cohorts mode narrows that to the same kind of work, one row per edit turn, with median and P90 cost per edit turn and the sample list you can read yourself. Turns that mixed two models are excluded and counted, never assigned to one. `codeburn optimize` goes further and prints a Model defaults recommendation when a project has enough edit turns to judge: a cheaper model you already used there whose one-shot rate held up, applied with `codeburn act apply-model <project>`. See [Cohort comparison](docs/compare-cohorts.md).

</details>

<details>
<summary><strong>Which project costs the most, and which branch inside it?</strong></summary>

Open the Spend page and pick a project in the By branch panel. Each branch row shows its cost, calls, tokens, distinct sessions and activity window, attributed turn by turn, so a session that switched branches lands on both rows with its own slice instead of counting twice. From the terminal the same report is `codeburn spend --format branch-json`. Branch is recorded per turn by Claude Code and by almost nothing else, so the coverage note under the rows splits the project three ways: spend on named branches, spend before a branch was recorded, and spend from tools that carry no branch at all. See [Spend by branch](docs/by-branch.md).

</details>

<details>
<summary><strong>Do my subagents cost more than they save?</strong></summary>

`codeburn sessions --by-work-unit` gives one row per orchestration root with its delegated children folded underneath, so the parent and its fan-out read as one number. `codeburn models --by-agent` splits each model's spend by the Claude subagent that drove it, with main sessions and other tools bucketed under `main`. The dashboard has a Claude Agent Types panel with calls and cost per agent type, and Delegation is one of the task categories. CodeBurn tells you what the fan-out cost. Whether the same work would have been cheaper in one long session is not something it can measure.

</details>

<details>
<summary><strong>What did that pull request cost me?</strong></summary>

The app has a Pull requests page, and `codeburn sessions --by-pr` is the same report in the terminal. It groups spend by the PR links your sessions recorded, and expanding a row takes you to the sessions behind it. Turns that touched more than one PR contribute their share to each, so the rows are not an exclusive split, and spend tied to no PR is labeled rather than hidden. The links come from what the session wrote down, so CodeBurn never calls GitHub and never checks whether the PR merged. For that part, `codeburn yield` correlates sessions with commits and sorts the spend into productive, reverted and abandoned, and the Overview's Cost per outcome panel shows cost per commit and cost per productive session. See [Yield](docs/yield.md).

</details>

**Subscriptions and limits**

<details>
<summary><strong>I pay a flat fee for Claude Max. Why does CodeBurn show me dollars?</strong></summary>

The dollar figure is what your tokens would have cost at API rates. It is not an invoice. The card labels it API-equivalent, not a live provider window. It is still the only per-session, per-project, per-model number you can get on a subscription, because a subscription gives you one price and no breakdown. Run `codeburn plan set claude-max` and the Plans page then shows what you have spent this cycle as a share of the plan, and whether you are on track or on pace to exceed it. See [Plans and quota](docs/plans-and-quota.md).

</details>

<details>
<summary><strong>I keep hitting my 5-hour or weekly limit. Can I see it coming?</strong></summary>

`codeburn quota` asks each provider how much of your plan is left, signing the request with the credential that tool already stores on your machine. For Claude that is a 5-hour row and a weekly row, each with a percentage used and a reset time, shown as `42% used · resets in 3h 20m` on the Plans page's Live quota panel. The Capacity Dock carries the same reading, and the macOS menu bar can carry a second line with quota remaining and its countdown. CodeBurn does not predict the hour you will run out. What you get is how full the window is and when it clears.

</details>

<details>
<summary><strong>Is my plan the right size, or am I paying for capacity I never use?</strong></summary>

Set what you pay for with `codeburn plan set claude-max`, or `claude-pro`, `cursor-pro`, `copilot-pro`, or `custom --monthly-usd 200 --provider codex`. The Plans page then shows spend this cycle against that budget with a pacing line, either On track or on pace to exceed with the projected figure and the date. After two or three cycles the pattern is clear. Consistently under a quarter of the plan means you are buying capacity you do not use, and consistently over means the cheaper plan is costing you. CodeBurn shows the share and the pace, and leaves the choice of plan to you.

</details>

<details>
<summary><strong>Three tools, three subscriptions. What is my real total?</strong></summary>

Plans are stored per provider, so `codeburn plan set claude-max`, `codeburn plan set cursor-pro` and a custom Codex plan sit side by side rather than blending into one figure. `codeburn plan` prints them all, and the app carries one card per active plan with its own spent, percentage and overage. The spend tables stay per tool underneath, so you can see which subscription is carrying the work and which one is idle. Copilot is tracked in AI credits rather than dollars, because credits are what Copilot actually meters.

</details>

**How my agent works**

<details>
<summary><strong>My agent reads the same file twenty times. How do I see that and stop it?</strong></summary>

`codeburn optimize` has a detector for exactly this, reported as "Claude is re-reading the same files" with the files and what the re-reads cost. Next to it sit reads into `node_modules`, `.git` and `dist`, and sessions that edit far more than they read first. Those two are the ones a written rule can fix: `codeburn optimize --apply` appends a marker block to the current project's `CLAUDE.md`, shows you the file before it writes, and backs it up under `~/.config/codeburn/actions/`. `codeburn act undo --last` puts it back. The re-read finding itself has no file to edit, so the fix there is how you open the next session.

</details>

<details>
<summary><strong>How much of my context is tool output, and what is it costing me?</strong></summary>

Run `codeburn context` and pick a session. It works for Claude Code and Codex, and gives you a tree: `assistant` split into text, reasoning and tool calls with a row per tool, `user` split into text, images, compaction summaries and meta, then `tool` with the `tool-result` line, and `system`. The headline shows the exact context size from the last call's usage next to the model's window. The tree counts tokens rather than dollars, because that context is re-sent every turn and its price depends on how much of it came from cache. For the dollars over a period, `codeburn models` prices the same sessions.

</details>

<details>
<summary><strong>Which MCP servers and skills am I paying for but never using?</strong></summary>

`codeburn optimize` compares what is configured against what was actually invoked. It names MCP servers configured but never called, servers with many tools and almost none used, and skills, agents and slash commands that are defined and never invoked. An MCP server's tool schemas ride along in the prompt whether you call it or not, so an unused one costs tokens on every turn. `codeburn optimize --apply` removes the server entry from `~/.claude.json` or the project's `.mcp.json`, and moves unused skills into `~/.claude/skills/.archived/` rather than deleting them.

</details>

<details>
<summary><strong>How often does my agent actually get it right first try?</strong></summary>

The one-shot rate. It is the One-shot figure on the app's Overview, a column in the dashboard's activity table, and a per-model row in `codeburn compare`. A retry is counted when the same file is edited again after a shell command ran in between, which is the shape of an edit that did not work. Editing a different file after a shell step is not a retry. Coding at 90% means nine edit turns in ten needed no second pass. File-level tracking works for Claude, Codex and Goose. Other tools fall back to tool names, so their figure is rougher. See [How it works](docs/how-it-works.md).

</details>

<details>
<summary><strong>How does CodeBurn know a session was coding rather than debugging or planning?</strong></summary>

From the tools the session used and the words in your own messages, with no model call anywhere. Edit and Write make it Coding. Error and fix words alongside tool use make it Debugging. `pytest` or `vitest` in a shell command makes it Testing. Read and Grep with no edits make it Exploration, and the Agent tool makes it Delegation. There are 13 categories and the rules are deterministic, so the same session always lands in the same category. The full table is in [How it works](docs/how-it-works.md).

</details>

**Trust the numbers**

<details>
<summary><strong>On a subscription the dollars are an estimate. What is estimated and what is measured?</strong></summary>

The tokens are measured for most tools. Claude Code, Codex, Gemini, Zed, OpenCode and others write real per-call input, output and cache counts into their own session files, and CodeBurn reads those rather than guessing. The price applied to them is published API pricing, so the dollar figure is arithmetic on measured tokens, not a guess about your bill. A few tools record no counts at all, so Cursor, Kiro and some Copilot sessions are estimated from content length, and those are marked estimated in the tables. `codeburn audit` prints a row per provider and model saying where every number came from.

</details>

<details>
<summary><strong>Where do the prices come from, and what if a vendor changes them?</strong></summary>

From [LiteLLM](https://github.com/BerriAI/litellm), fetched and cached for 24 hours under `~/.cache/codeburn/`, so a change reaches you within a day of LiteLLM picking it up. The common Claude and GPT models also carry bundled fallback prices, so a lookup miss falls back to a known rate for those. Anything else shows as unpriced rather than guessed. If a model shows $0 its name matched no price row. `codeburn models --unpriced` lists those ids, `codeburn model-alias` points a proxy-rewritten name at the real model, and `codeburn price-override` sets exact rates yourself. A session is priced with today's rates when it is read, not with the rates of the day it ran. See [Configuration](docs/configuration.md).

</details>

<details>
<summary><strong>Claude Code deletes its sessions after 30 days. Does my history go with them?</strong></summary>

The daily numbers do not. CodeBurn keeps a durable daily history under `~/.cache/codeburn/`, holding each day's cost, tokens and per-project and per-model split for ten years, so `codeburn report` and `codeburn status` keep answering for days whose transcripts are gone. The per-session detail does go, because it only ever lived in the transcript. So anything that reads sessions, `codeburn sessions`, `models`, `spend` and `compare-periods`, will show less for an old range than `report` does for the same range. Compare periods lists those days by name with their unexplained amount instead of quietly folding them into the totals.

</details>

<details>
<summary><strong>What actually leaves my computer, and how can I check?</strong></summary>

Model prices are fetched from LiteLLM and cached for 24 hours, so that call happens at most once a day. `codeburn quota` asks each provider you are signed in to how much of your plan is left, using the credential that tool already stores on your machine. If you set a non-USD currency, exchange rates come from Frankfurter, cached the same way. Commands that install something, such as `codeburn menubar`, reach GitHub releases, which is the point of them. Your prompts, your code, your file names and your project names are read on disk and never sent anywhere, and nothing else leaves unless you point CodeBurn at a destination yourself. It is not a proxy, so no traffic of yours passes through it. You can watch what does leave with a network monitor.

</details>

**Everything else**

<details>
<summary><strong>I work on a laptop and a desktop. Can I get one number across both?</strong></summary>

Yes, on the same local network. On the second machine run `codeburn share --pair`, which opens a pairing window and prints a PIN. On your main machine run `codeburn devices add` to find it and pair with that PIN, then `codeburn devices` shows combined totals by machine. `codeburn devices rm <name>` forgets one again. Sharing stops after ten minutes idle unless you pass `--always`, and pairing never leaves your network. You can also discover and pair from the browser dashboard at `codeburn web`. See [Web dashboard](docs/web.md).

</details>

<details>
<summary><strong>Can my agent read these numbers itself, without me leaving the conversation?</strong></summary>

Register the local MCP server with `claude mcp add codeburn -- npx -y codeburn mcp`. It runs over stdio and exposes two tools: `get_usage` for spend and usage broken down by tool, model, project and task, and `get_savings` for the waste findings, retry tax and routing waste, which is the slower of the two. Any MCP client works, with command `npx` and args `-y codeburn mcp`. It reads the same files on disk the CLI reads, and project names are pseudonymized unless the agent asks for the real ones. See [MCP](docs/mcp.md).

</details>

<details>
<summary><strong>Why is this free, and what is going to cost money later?</strong></summary>

CodeBurn is MIT licensed and all of it is in this repository: the CLI, the desktop app, the menu bar and tray apps, the GNOME extension. There is no account, no paid tier and no feature held back for one. It is free because it reads files you already have, which costs nothing to run. What it does cost is time, because 41 integrations sit on top of tools that change their config paths and data formats without warning. [Sponsorship](https://github.com/sponsors/iamtoruk) is what pays for keeping up with them.

</details>

## Telemetry

<details>
<summary><strong>What the desktop app sends, and how to turn it off</strong></summary>

The **CLI sends nothing.** No wrapper, no proxy, no phoning home.

The **desktop app and the Windows tray** can send an anonymous usage report, and only after you
decide on the first-launch consent screen. The toggle defaults to **off** in the EU, EEA, UK and
Switzerland, and anywhere the region is unknown; **on** elsewhere. Either way it is your call, and
you can change it any time in **Settings > Privacy & data > Anonymous telemetry**. Turning it off
stops all sending, clears anything queued, and mints a fresh install id so past and future reports
cannot be linked.

The only identifier is a random id generated on your machine. Events carry the calendar day, never
a clock time. Alongside each batch go the app version, platform, architecture and country.

**`usage_snapshot`** goes out at most once per calendar day. It is computed by the CLI so the app
and the tray report the identical shape, and every magnitude in it is a bucket, never an exact
figure. The daily report includes the names of the models, tools, skills and MCP servers you use,
alongside those bucketed counts.

| Field | What it carries |
|-------|-----------------|
| `schema`, `period` | Snapshot version, and the period label you were looking at (for example `30 Days`) |
| `providerCount`, `costBucket` | How many providers had usage, and total spend as a range: `<1`, `1-10`, `10-50`, `50-200`, `200-1k`, `1k+` USD |
| `models` | Up to 8 model names, each with its cost bucket, turn-count bucket, one-shot rate, and up to 6 task categories with a turn bucket and share of that model's turns |
| `categories` | Up to 12 task category names (Coding, Debugging, Planning, …) with a turn bucket, one-shot rate, and up to 3 model names |
| `providers` | Up to 8 provider names with a cost bucket each |
| `mcpServers`, `skills`, `tools` | Up to 12 names each with a call-count bucket: `0`, `1-10`, `10-100`, `100-1k`, `1k+` |
| `sessions` | Session count bucket, and median session length as a bucket: `<5`, `5-15`, `15-60`, `60-240`, `240+` minutes |
| `efficiency` | Cache hit rate and retry tax as shares of the total, to two decimals |

The other events are name-only:

| Event | Fields |
|-------|--------|
| `app_open`, `app_close` | Session length in whole minutes |
| `section_view` | Which section you opened (`overview`, `spend`, …) |
| `cold_start` | Milliseconds to the first painted overview, and whether it timed out |
| `cli_error` | Error kind and the command name, capped at 20 per kind per day |
| `optimize_apply` | The finding id you took a fix for (`unused-mcp`, `claude-md-too-long`, …) and the fix type |
| `plan_set` | Provider and plan preset id |
| `export` | Format (`csv` or `json`) and provider |
| `compare_view` | The two model names being compared |
| `settings_change` | Setting name and its new boolean or enum value |

**Never collected:** prompts, code, file contents, file or folder names, project names, branch names,
working directories, session titles, PR links, API keys, exact dollar amounts, exact counts, clock
times, or IP-based location beyond the country.
The names of the models, tools, skills and MCP servers you use are collected, as the table above
sets out, and a whitelist sanitizer drops anything that is not a short string, a finite number or a
boolean before it leaves the machine.

**To turn it off:** decline on the consent screen, or open **Settings > Privacy & data** and switch
**Anonymous telemetry** off.

</details>

## License

MIT.

CodeBurn is an AgentSeal open-source project and is not affiliated with CodeBurn Bt. or codeburn.hu.

## Credits

Pricing data from [LiteLLM](https://github.com/BerriAI/litellm). Exchange rates from [Frankfurter](https://www.frankfurter.app/).

Built by [AgentSeal](https://agentseal.org).

The Capacity Dock's provider-usage tracking was informed by [CodexBar](https://github.com/steipete/CodexBar) by Peter Steinberger ([@steipete](https://github.com/steipete)), an MIT-licensed menubar app for AI provider usage. Thanks.
