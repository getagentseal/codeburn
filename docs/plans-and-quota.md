# Plans and provider quota

## Plans

```bash
codeburn plan set claude-max                                  # $200/month
codeburn plan set claude-pro                                  # $20/month
codeburn plan set cursor-pro                                  # $20/month
codeburn plan set copilot-pro                                 # 1500 AI Credits ($15 equivalent)
codeburn plan set custom --monthly-usd 200 --provider codex   # ChatGPT Pro-style custom plan
codeburn plan set custom --credits 20000 --provider copilot   # org Copilot allotment
codeburn plan reset --provider codex                          # remove one provider plan
codeburn plan set none                                        # disable plan view
codeburn plan                                                 # show configured plans
codeburn plan reset                                           # remove plan config
```

Subscription tracking for Claude Pro, Claude Max, Cursor Pro, Copilot (AI credits), and custom provider plans. Plans are stored per provider, so you can track Claude and Codex/Cursor subscriptions at the same time; the dashboard shows one overage line per active provider plan. A legacy/custom `all` plan remains a single aggregate plan and is replaced when you add a provider-specific plan, avoiding double-counted overage rows. Existing single-plan config is still read as a fallback. USD presets use publicly stated plan prices (as of April 2026). Copilot presets use official individual AI-credit allotments (Pro 1,500 / Pro+ 7,000 / Max 20,000; fetched 2026-08-23) — not the $10 / $39 / $100 sticker prices — and spend is `total_nano_aiu / 1e9`, never token-priced USD.

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

