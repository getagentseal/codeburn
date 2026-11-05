# Plans and provider quota

## Plans

```bash
codeburn plan set claude-max                                  # $200/month
codeburn plan set claude-pro                                  # $20/month
codeburn plan set cursor-pro                                  # $20/month
codeburn plan set copilot-pro                                 # 1500 AI Credits ($15 equivalent)
codeburn plan set google-ai-pro                               # $19.99/month, Antigravity usage
codeburn plan set custom --monthly-usd 200 --provider codex   # ChatGPT Pro-style custom plan
codeburn plan set custom --credits 20000 --provider copilot   # org Copilot allotment
codeburn plan reset --provider codex                          # remove one provider plan
codeburn plan set none                                        # disable plan view
codeburn plan                                                 # show configured plans
codeburn plan reset                                           # remove plan config
```

Subscription tracking for Claude Pro, Claude Max, Cursor Pro, Copilot (AI credits), and custom provider plans. Plans are stored per provider, so you can track Claude and Codex/Cursor subscriptions at the same time; the dashboard shows one overage line per active provider plan. A legacy/custom `all` plan remains a single aggregate plan and is replaced when you add a provider-specific plan, avoiding double-counted overage rows. Existing single-plan config is still read as a fallback. USD presets use publicly stated plan prices (as of April 2026). Copilot presets use official individual AI-credit allotments (Pro 1,500 / Pro+ 7,000 / Max 20,000; fetched 2026-08-23) — not the $10 / $39 / $100 sticker prices — and spend is `total_nano_aiu / 1e9`, never token-priced USD. Google presets (`google-ai-pro` $19.99, `google-ai-ultra-5x` $99.99, `google-ai-ultra-20x` $199.99; US prices fetched 2026-10-07) count Antigravity usage only, since Gemini CLI no longer signs in with these plans.

## Provider quota

`codeburn quota` reads how much of each provider's plan you have already spent, from the credentials the tools themselves keep on this machine. Claude, Codex, Gemini, GitHub Copilot and Kimi are read from their own signed-in sessions; Antigravity is read from its local language server.

```bash
codeburn quota               # table of every provider and its windows
codeburn quota --format json # machine-readable, pipe to jq
```

Providers you are not signed in to are listed with `available: false` and no error. Reads run in parallel with a short per-provider timeout, and the command always exits 0 so a status bar or tray can poll it safely.

```json
{
  "providers": [
    {
      "id": "claude",
      "name": "Claude",
      "available": true,
      "plan": "Max 20x",
      "windows": [{ "label": "Weekly", "usedPct": 42.5, "resetsAt": "2026-09-08T12:00:00.000Z" }]
    }
  ]
}
```


## Claude accounts

If you switch between Claude identities on one machine (a personal plan and a work login, or one login moving between a personal and a team organization), codeburn can split Claude usage by the one that was signed in. An identity is an organization, or the account when Claude reports no organization.

Claude Code transcripts do not record which account wrote them. What exists is a live snapshot: the account currently signed in to each Claude config directory (`oauthAccount` in its `.claude.json`). So every time codeburn reads sessions (CLI, menubar or desktop refresh), it reads that snapshot and appends a line to `~/.config/codeburn/identity-log.v1.json` when the account or organization differs from the last line for that config directory. The line holds the first 12 hex characters of the sha256 of the account and organization ids, the organization name as the default label, the time, and the config directory. Raw ids, emails and tokens are never written, and the log never leaves the machine: sync and sharing do not send it.

A Claude session belongs to the identity of the last observation at or before its first message, in its own config directory. That is as precise as the observations:

- A switch is dated to when codeburn next observed it, not to the moment you logged in. Sessions started in that gap go to the identity observed before.
- Sessions started before codeburn first observed an identity are `unattributed`, and stay that way.
- A config directory without a signed-in account (an API key user) records nothing, so its sessions stay with the last identity observed there, or `unattributed`.

With one identity nothing changes anywhere. Once codeburn has seen two or more, `codeburn report --format json` carries `identities`, `codeburn sessions --format json` an `identity` per row and `codeburn export` a last `identity` column, whatever the period or filter. The report dashboard panel and the desktop Overview card and Sessions filter appear when the period itself holds two or more.

```bash
codeburn identity list                        # observations, and sessions and cost per identity
codeburn identity-label 3f2a9c1d0b7e work     # rename an identity locally
codeburn report --format json --identity work # one identity only (label or hash)
codeburn sessions --identity unattributed
```
