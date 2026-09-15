# Capacity Dock

Status: implementation specification

Epic: Quota Intelligence (#725)

## Product decision

Capacity Dock is an optional, always-available quota surface for the native
CodeBurn menu utility. The resting surface shows one preferred provider. Hover
or click expands the rail to the providers the user selected in Settings, and
hovering a provider opens an inward-facing usage bubble. The visual target is the
compact black provider rail and speech-bubble detail card in the supplied
reference image.

This interaction is preferable to an always-expanded N-provider rail. It keeps
the screen cost proportional to the user's primary provider while preserving
one-move access to the selected comparison set.

## Scope

V1 includes:

- A rail that can attach to any screen edge or detach into a floating widget,
  disabled by default for existing installs. Left/right use a vertical layout;
  top/bottom use a horizontal layout.
- One preferred provider in the resting state.
- A Settings toggle to show or hide the dock.
- A Settings picker for the resting provider.
- A compact provider picker containing only providers for which CodeBurn has a
  connected or usable stale source. CodeBurn owns the 69-provider connection
  catalog and its authentication metadata.
- Hover expansion, click-to-pin expansion, and outside-click dismissal.
- A provider usage bubble with quota windows, progress, percent used, reset
  timing, plan, connection state, and supported footer facts.
- Reuse of the six native `AppStore.quotaSummary(for:)` adapters plus
  CodeBurn-owned adapters for newly supported providers. Catalog entries without
  a native adapter remain discoverable in Settings but never claim a live
  connection. Generic providers ride the existing quota cadence rather than
  creating another refresh timer.
- Source-first connection: existing provider app, CLI, OAuth, browser session,
  environment, and localhost credentials are discovered in place. CodeBurn
  persists only overrides the user explicitly enters and saves.
- Persisted horizontal and vertical placement after dragging, including the
  selected dock edge and a genuinely detached state.
- A live size control in General Settings, persisted from 70% to 120%. The
  default is a compact 85% so the resting surface stays peripheral.
- A persisted appearance choice. Graphite remains the default; Liquid Glass is
  optional and uses the native macOS 26 material when available, with a
  restrained material fallback on older supported systems.
- VoiceOver labels and reduced-motion-compatible transitions.

V1 does not include:

- Cross-device quota aggregation.
- A replacement for the existing menu bar popover or provider tabs.
- Reordering providers in Settings. Selected providers use the audited
  CodeBurn catalog order.
- Notification-window introspection. The default lane avoids the normal banner
  zone and notifications remain above the dock; the user can drag the rail if
  their notification stack is unusually tall.

## Interaction contract

### Resting

- The rail is 88 points thick with a 52-point quota ring at 100% size. Provider
  artwork is optically capped at 26 points, percentage type at 17 points, and
  each provider occupies an 84-point cell with 12 points between cells. The
  rail reserves 18 points at either end. This restores the visual presence of
  the icon and channel while retaining calm outer margins.
- The preferred provider is the user's explicit choice. If it is not selected,
  normalize the preference to the first selected provider. If no valid
  preference exists, prefer Codex, then Claude, then the first supported
  provider.
- A missing or disconnected quota is `--`, never `0%`.
- The gauge reports one quota horizon: the weekly (else monthly) billing window
  by default, or the provider's short rolling window (5-hour, hourly, daily,
  session) when the user has switched it. The choice is stored per provider, so
  Claude can rest on its 5-hour window while Codex stays weekly, and a stored
  horizon the provider stops reporting falls back to the one it does report
  rather than blanking the gauge. Switching never changes the rail's size.
- Interactive provider cells remain at least 84 points along the provider axis,
  comfortably above the macOS 20-point minimum and 28-point default control
  targets. The detail hierarchy follows macOS text styles at 17, 12, 11, and
  10 points; connection remedies wrap instead of truncating.

### Expanded

- Hovering the resting rail expands after an 80 ms intent delay.
- Clicking toggles a pinned expanded state.
- Expanded content lists only the providers selected in Settings.
- Clicking a provider makes it the preferred/resting provider and keeps the
  rail expanded for that interaction.
- Clicking the provider that already rests in the rail switches its gauge to its
  other quota horizon when it reports two, and keeps the rail pinned; a provider
  with one window keeps the plain pin toggle. VoiceOver and keyboard users get
  the same switch as a named accessibility action on the provider cell. Escape
  and an outside click still unpin.
- Leaving both rail and detail bubble collapses after a forgiving 180 ms grace
  period unless pinned.
- An outside click or Escape unpins and collapses.

### Detail bubble

- Hovering a provider reveals a graphite, rounded speech bubble on the inward
  side of the rail, with a broad curved neck aimed at the provider cell. A
  right-edge rail opens left, a left-edge rail opens right, and top/bottom rails
  open below/above respectively.
- The header is `<Provider> Usage`, with the provider glyph and optional plan.
- Each quota window shows its label, progress bar, percentage, and reset
  countdown. The most constrained available window supplies the ring value;
  this matches the reference's glance-first use and avoids understating a
  provider whose secondary window is closer to exhaustion.
- Under that, one line says whether the window lasts: `Lasts until reset` or
  `Runs out in 2d 8h`, and on windows of six hours or less, where a linear
  run-out ETA is not defensible off a single burst, the pace stage instead
  (`On pace`, `40% in deficit`, `30% in reserve`). It is the same whole-window
  projection the Plan tab's caption uses, computed against the window length
  the adapter reports — never a length inferred from the display label, which
  mislabels any provider that picks its label from the distance to the reset.
  It is silent early in a window, on an exhausted window, without a reset time,
  without a validated duration, and on data that is stale, disconnected or
  older than the ten-minute freshness horizon. The dock reserves its height
  whether or not a column has a caption, because the panel's frame is computed
  rather than fitted; the agent-tab quota hover card draws the same line under
  its bar, indented past the label column, and simply omits it when silent
  because that card is fitted.
- When a vendor resets one of the provider's windows before its scheduled time,
  a band under the header says so (`Weekly limit reset 18h early`) for twelve
  hours after the reset was seen. It is a notice like the staleness line, with
  the same inset, padding, divider and reserved height, and it can sit alongside
  it. Detection rides the existing refresh lifecycle and adds no polling: two
  signals, a reset time that jumps to a new cycle while the stored one still had
  time to run, and usage emptying while the reset time stands still, coalesced so
  one goodwill reset is one notice and one notification. It stays silent on a
  normal scheduled reset, a plan change, clock or timestamp skew, a window that
  appears or disappears between fetches, a window's first observation, and a
  provider reconnecting after a terminal failure or a fresh bootstrap.
- Every dock provider runs through the same detector as its own fetch succeeds,
  and everything it keeps — the previous fetch's readings, the record of what
  has been announced, the band, and the history caption — is scoped to that
  provider and that window, so one provider's early reset can never move
  another's state. A window needs both a reset time and a validated length to
  produce anything, so today only Claude and Codex announce: the other live
  adapters (Antigravity, ClinePass, Copilot, Cursor, Gemini, Grok, Kimi Code,
  Z.ai) report a reset time but no window length, and are silent under the same
  rule that keeps any unvalidated window quiet. They need no further wiring when
  their adapters start carrying one. A window that has no key of its own is
  identified by the label the adapter already shows; a label that changes with
  the window's state costs a baseline, which is silence, never a false alarm.
- Stale or retrying data remains visible and is labeled/dimmed. A terminal
  authentication/configuration failure provides a Connect/Reconnect action in
  the bubble itself. Network, rate-limit, parse, and provider outages remain
  retryable and do not masquerade as a disconnected account. Unknown data
  remains unknown.
- The bubble must not make the transparent space between the bubble and rail
  intercept clicks in other applications.

## Placement and window behavior

- Use a narrowly-owned borderless, non-activating `NSPanel` for the rail and a
  separate non-activating panel for the detail bubble. SwiftUI owns display and
  interaction state; the AppKit controller owns panel lifecycle and placement.
- Use floating level, not status-bar level. The dock remains above ordinary app
  windows without outranking system notification banners.
- Join Spaces and behave as a full-screen auxiliary surface. Do not enter the
  Window menu or app switcher, become key, steal focus, or show a Dock icon.
- Default to the right edge and 156 points below the visible top edge. Attached
  left/right rails are flush with the physical side of the display; the top
  rail attaches immediately below the menu bar so it remains visible and easy
  to snap. Top/bottom rails present horizontally. Clamp detached rails and
  detail bubbles to the current screen's usable area.
- Dragging derives every frame from an immutable mouse-down frame and absolute
  AppKit screen coordinates. It never feeds the panel's moving coordinate space
  back into its own gesture, so the rail stays under the pointer without jitter
  or accumulated lag. Pulling away from the attached edge continuously retracts
  the flare until the panel becomes a conventional rounded floating widget.
  Releasing within the snap lane attaches to the nearest of all four edges. The
  last orientation is retained while floating, so reattachment does not cause
  gratuitous rotation.
- Persist normalized horizontal and vertical offsets so placement survives
  display-size changes. An explicit detached marker distinguishes floating from
  the fresh-install default of right-docked.
- Re-place on screen-parameter changes and wake.

## Visual contract

- Graphite-black rail and bubble, continuous sculpted corners, no rectangular
  panel shadow, and white primary text. A restrained top-left tonal lift makes
  the surfaces read as material without decorative blur or colored glass.
  Liquid Glass is an opt-in appearance using one coherent native material per
  surface, with legibility preserved by the system rather than stacked effects.
  Reduce Transparency substitutes the opaque graphite surface.
- Attached rails use a 44-point surface-tension shoulder at reference scale.
  The touched edge remains pixel-flush while its contact chord broadens inside
  the existing panel rectangle. The body flows into that contact with two
  continuous curves; it does not add off-screen panel length, fins, horns, or a
  background sliver. The same silhouette is mirrored for all four edges and
  retracts continuously into ordinary rounded corners during detachment.
- Every catalog provider resolves a packaged SVG. The set combines official
  marks, CC0 Simple Icons assets, and MIT-licensed provider vectors documented
  in `THIRD_PARTY_NOTICES.md`; existing CodeBurn PNGs remain compatibility
  fallbacks. Unknown future providers use CodeBurn's neutral generated sigil
  rather than an invented approximation of their trademark.
- Ring progress reads as a rounded neon tube filling a recessed channel: dark
  groove, 4-point identity-color fill, restrained bloom, rounded caps, and a
  fine specular highlight. Dangerous/terminal states gain a semantic warning
  treatment without replacing provider identity at normal utilization.
- Vertical rails grow and retract downward from a fixed top edge; horizontal
  rails grow along their provider axis without jumping away from their docked
  edge. A cancelable
  frame runner interpolates the panel frame and content together, so expansion
  never jumps upward. Additional rows fade and lift through the same progress
  value as the 520 ms expansion and 440 ms retraction, so the tray reads as one
  continuous reveal rather than rows appearing ahead of their container. Detail
  cards ease from the rail and fade in/out. Dragging,
  screen changes, and Reduce Motion cancel animation and apply one atomic frame,
  preventing ghosting or stale completion jitter.
- Percent values use the system SF family with tabular digits; the widget does
  not substitute a monospaced typeface.
- Rail and detail silhouettes use one continuous path each. Shadows must not
  fill or expose the transparent rectangular panel bounds.

## Settings contract

Add a `Capacity Dock` section to General Settings:

- `Show Capacity Dock` toggle.
- `Resting provider` menu, limited to selected providers.
- `Size` slider from 70% to 120%, defaulting to 85%.
- `Appearance` menu with `Graphite` and `Liquid Glass`.
- Early-reset notifications are a switch in the General Settings
  `Notifications` section, default on, stored under
  `codeburn.quota.earlyResetNotificationsEnabled`. With it off the dock band
  still appears; only the system notification is withheld.
- A compact switch list containing only connected or usable stale providers.
  Provider connection and credential entry remains in the Providers section;
  General Settings never presents the entire 69-provider catalog as dock
  choices.
- Prevent an enabled dock from ending with zero selected providers. Selection
  persistence must tolerate removed/unknown identifiers and normalize them.

The controller observes preference changes and updates or closes panels
immediately. Turning the dock on must not cause a Keychain prompt. Background
refresh may silently discover selected providers from their own local sources;
any source-owned consent prompt is reserved for an explicit Connect action.

## Code boundaries

- `CapacityDockPreferences`: typed UserDefaults keys, supported providers, and
  normalization.
- `CapacityDockPlacement`: pure placement and normalized-offset calculations.
- `CapacityDockController`: AppKit panel lifecycle, event monitors, placement,
  and preference observation.
- `CapacityDockView`: SwiftUI rail and provider rows.
- `CapacityDockDetailView`: SwiftUI usage bubble.
- `ProviderIcon`: reusable icon lookup extracted from the Settings-only cache.
- `ProviderConnectionCatalog`: CodeBurn-owned provider and authentication
  inventory.
- `CapacityDockProviderQuotaService`: dispatch into native CodeBurn provider
  adapters without copying passive credentials.
- `CapacityDockMotion`: pure timing/easing plus edge-aware interpolation policy.
- `EarlyQuotaReset`: pure early-reset detection, the bounded notice window, and
  the local history summariser behind the hover card's caption.
- `EarlyQuotaResetMonitor`: per-provider baseline, announcement record, cycle
  ledger and delivery through the existing `UpdateNotifier`. One `UserDefaults`
  record per provider id, under the key the feature first shipped with.
- `AppDelegate`: create/start/stop the controller and include quota/preferences
  in the existing observation re-arm. It must not own dock rendering details.

## Verification and acceptance

Automated:

- Preference normalization, defaults, at-least-one selection, and preferred
  provider fallback.
- Placement on main/external/narrow screens, all four edge snaps, persisted
  floating state and offset clamping, horizontal top/bottom layout, and inward
  detail-card clamping.
- Headline selection chooses the most constrained known window and preserves
  unknown/disconnected states.
- Interaction state transitions for hover, pin, outside click, and delayed
  collapse, including drag suppression of hover transitions.
- Reference-scale rail metrics and the four mirrored surface-tension
  silhouettes' interactive paths.
- Existing Swift test suite passes.
- Provider catalog IDs, authentication methods, and adapter-support flags match
  CodeBurn's audited inventory.
- Authentication/configuration errors are terminal; service/network failures
  retain stale data and remain retryable.
- Debug and release SwiftPM builds pass.

Runtime:

- Launch a real `.app` bundle from the exact feature SHA.
- Confirm the existing status item and popover still work.
- Enable Capacity Dock in Settings and verify it appears in the upper-right
  notification-safe lane without activating CodeBurn.
- Verify one-provider rest, hover expansion, click pinning, provider selection,
  detail hover, outside-click collapse, dragging and detachment, persistence,
  every dock edge and orientation, multi-display clamping, Space/full-screen
  behavior, stale/unknown rendering, direct Connect, stationary edge anchoring,
  smooth reversible motion, and Reduce Motion.
- Capture the exact SHA, bundle path, process identity, and screenshots used for
  the user click-through handoff.

## Backlog sizing (not in this implementation)

- **Pin multiple providers in the retracted rail — S/M (1–2 days).** Keep the
  current single-provider rest as the default, add an unobtrusive engraved pin
  affordance to each provider, and define a bounded compact-state overflow rule
  so several pins do not recreate the fully expanded rail. Edge-aware ordering
  and keyboard/accessibility states are part of the work, not visual follow-ups.
- **Choose the tracked quota window from the detail card — S/M (1–2 days).**
  Persist a stable quota-window identifier per provider, make each row
  selectable, update the headline ring immediately, and fall back safely when a
  provider renames or removes a window.
- **Pulse a ring while a provider is actively used — signal-dependent.** The
  visual pulse is S (hours). Process-presence heuristics are also S but can only
  claim that an app is running. Reliable request activity through a CodeBurn
  wrapper/proxy is M (2–4 days). Arbitrary system-wide API-key activity is L/XL
  (roughly 1–2 weeks), permission-sensitive, and cannot be made fully reliable
  when unrelated tools communicate directly with providers.
- **Show running Codex tasks in the Codex detail card — M/L.** A prototype is
  about 2–4 days if a stable local task/session source is available; a robust
  background-fed list with running/waiting/completed states, click-to-open,
  bounded history, and compatibility handling is closer to one week.
