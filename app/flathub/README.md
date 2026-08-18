# Flathub submission

These files publish CodeBurn Desktop on Flathub. The manifest repacks the
Linux deb from GitHub Releases, so no source build is needed.

## First-time submission

1. Fork `https://github.com/flathub/flathub` (uncheck "fork only master").
2. Create a branch off `new-pr` named `org.agentseal.CodeBurn`.
3. Copy the three `org.agentseal.CodeBurn.*` files from this directory into the
   repo root of that branch.
4. Open a pull request against the `new-pr` branch of `flathub/flathub`.
5. A reviewer responds on the PR. After approval Flathub creates a dedicated
   `flathub/org.agentseal.CodeBurn` repo; future updates are PRs there.

## Local test build (any Linux machine or VM)

```sh
flatpak install flathub org.flatpak.Builder
flatpak run org.flatpak.Builder --force-clean --user --install \
  --install-deps-from=flathub --repo=repo builddir org.agentseal.CodeBurn.yaml
flatpak run org.agentseal.CodeBurn
```

## Sandbox permissions and persistent data

The manifest grants `--filesystem=home:ro`. CodeBurn only ever reads: session
logs in dot-directories all over the home directory, and the user's own project
directories, which git repo attribution, `CLAUDE.md` discovery and per-project
MCP config all depend on.

Enumerating provider directories individually was tried and dropped. It cannot
cover project directories at all — those are arbitrary paths — so `codeburn
yield` would attribute nothing and classify every session as abandoned. It also
silently drops any provider whose root is missing from the list, and a missing
grant surfaces as `ENOENT`, which is indistinguishable from "that tool isn't
installed". `~/.kimi-code`, `~/.clawdbot/agents` and `~/.local/share/devin/cli`
are all real roots absent from the snap's `personal-files` list.

Read-only is the property that matters, and `home:ro` gets it without any of
that. There are two writable exceptions:

- `~/.config/codeburn:create` — settings, the act journal, the sharing store and
  sync credentials all live under `dirname(getConfigFilePath())`.
- `xdg-download:create` — `codeburn export` needs a real destination. Under a
  purely read-only home it would write into the sandbox tmpfs and report
  success.

The `codeburn-run` wrapper fills two variables when the user has not set them to
a non-empty value (`getCodeburnCacheDir` and `getDataDir` both treat an empty
value as unset, so the guards use `:+` rather than `+`):

- `CODEBURN_CACHE_DIR` becomes `$XDG_CACHE_HOME/codeburn`, with `$HOME/.cache`
  as an explicit fallback so a launch that unsets `XDG_CACHE_HOME` cannot turn
  the cache directory into the literal `/codeburn`. Flatpak points
  `XDG_CACHE_HOME` at the app's persistent cache, so the pricing table and
  session caches survive exit instead of being rebuilt on every launch.
- `OPENCODE_DATA_DIR` becomes `$HOME/.local/share/opencode`. OpenCode otherwise
  resolves through `XDG_DATA_HOME`, which Flatpak redirects into the sandbox, so
  the provider would find nothing.

`tests/flatpak-grants.test.ts` pins the read-only property: it fails if a
writable whole-home grant reappears, if `home:ro` goes missing, or if a writable
grant is added without being declared and justified in that test.

## Each desktop release

Update in `org.agentseal.CodeBurn.yaml`:
- the deb `url` (new `desktop-vX.Y.Z` tag)
- its `sha256` (`gh api repos/getagentseal/codeburn/releases/tags/desktop-vX.Y.Z -q '.assets[] | select(.name | endswith(".deb")) | .digest'`)

and add a `<release>` entry in `org.agentseal.CodeBurn.metainfo.xml`.
Then PR the `flathub/org.agentseal.CodeBurn` repo; merging publishes.
