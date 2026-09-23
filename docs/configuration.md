# Configuration

## Currency

```bash
codeburn currency GBP          # set to British Pounds
codeburn currency AUD          # set to Australian Dollars
codeburn currency JPY          # set to Japanese Yen
codeburn currency CNY          # set to Chinese Yuan
codeburn currency RON          # set to Romanian Leu
codeburn currency              # show current setting
codeburn currency --reset      # back to USD
```

Any [ISO 4217 currency code](https://en.wikipedia.org/wiki/ISO_4217#List_of_ISO_4217_currency_codes) is supported (162 currencies). Exchange rates fetched from [Frankfurter](https://www.frankfurter.app/) (European Central Bank data, free, no API key) and cached for 24 hours. Config stored at `~/.config/codeburn/config.json`. The currency setting applies everywhere: dashboard, status bar, menu bar, CSV/JSON exports, and JSON API output.

## Model aliases

If you see `$0.00` for some models, the model name reported by your provider does not match any entry in the LiteLLM pricing data. This commonly happens when using a proxy that rewrites model names.

```bash
codeburn model-alias "my-proxy-model" "claude-opus-4-6"   # add alias
codeburn model-alias --list                                # show configured aliases
codeburn model-alias --remove "my-proxy-model"             # remove alias
```

Aliases are stored in `~/.config/codeburn/config.json` and applied at runtime before pricing lookup. The target name can be anything in the [LiteLLM model list](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) or a canonical name from the fallback table (e.g. `claude-sonnet-4-6`, `claude-opus-4-5`, `gpt-4o`). Built-in aliases ship for known proxy model name variants. User-configured aliases take precedence over built-ins.

## Local models, custom prices, and proxies

```bash
codeburn price-override my-model --input 0.27 --output 1.10   # USD per 1M tokens
codeburn model-savings "llama3.1:8b" gpt-4o                   # local model, counted as savings
codeburn model-flat-rate auto-genius                          # subscription SKU, $0 is correct
codeburn proxy-path ~/work/copilot-repo                       # subscription-covered project
```

`price-override` sets exact rates for any model (input, output, cache read, cache creation), useful for private deployments or models LiteLLM prices wrong. `model-savings` maps a free local model to a paid baseline: the local calls stay $0, and the dashboard shows what the same tokens would have cost on the baseline. `model-flat-rate` marks a subscription-billed product SKU so the unpriced warning stays quiet and `model-alias` is not suggested — aliasing those ids invents spend. `--remove` also opts out of a built-in SKU. `proxy-path` marks a project routed through a subscription-backed proxy (e.g. Claude Code over GitHub Copilot), so its API-rate cost is reported as subscription-covered and your net out-of-pocket stays honest. All four support `--list` and `--remove`.

## Environment variables

Override data directories and paths.

| Variable | Description |
|----------|-------------|
| `CLAUDE_CONFIG_DIR` | Override Claude Code data directory (default: `~/.claude`) |
| `CLAUDE_CONFIG_DIRS` | OS-delimited list of Claude data directories to scan together (e.g. `~/.claude-work:~/.claude-personal`). Sessions merge into one row per project. Overrides `CLAUDE_CONFIG_DIR` when set. |
| `CODEX_HOME` | Override Codex data directory (default: `~/.codex`) |
| `CODEBUFF_DATA_DIR` | Override Codebuff data directory (default: `~/.config/manicode`) |
| `CODEWHALE_HOME` | Override the exact CodeWhale home directory; sessions are read from `<CODEWHALE_HOME>/sessions` |
| `FACTORY_DIR` | Override Droid data directory (default: `~/.factory`) |
| `KIMI_SHARE_DIR` | Override Kimi Code CLI share directory (default: `~/.kimi`) |
| `KIMI_MODEL_NAME` | Override Kimi model name when Kimi sessions do not record the model |
| `LINGTAI_HOME` | Override LingTai data directory (default: `~/.lingtai`) |
| `LINGTAI_TUI_HOME` | Alternate override for LingTai data directory; `LINGTAI_HOME` takes precedence |
| `LINGTAI_TUI_GLOBAL_DIR` | Override LingTai TUI global directory used for project registry discovery (default: `~/.lingtai-tui`) |
| `OPENCODE_DATA_DIR` | Override the OpenCode-compatible data directory (default: `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`). Point at a renamed/forked build, e.g. `~/.local/share/mimicode`. Exact directory; no `opencode` suffix is appended. |
| `OPENCODE_DB_PREFIX` | Override the SQLite DB filename prefix for OpenCode discovery (default: `opencode`, matching `opencode*.db`); e.g. `mimicode` discovers `mimicode*.db`. SQLite storage only. |
| `QWEN_DATA_DIR` | Override Qwen data directory (default: `~/.qwen/projects`) |
| `VIBE_HOME` | Override Mistral Vibe home directory (default: `~/.vibe`) |
| `WARP_DB_PATH` | Override Warp database path (default: Warp Stable, then Warp Preview) |

