/*
 * CodeBurn GNOME Shell extension.
 *
 * Ships a native GNOME panel button whose popup mirrors the macOS app pixel for
 * pixel, built out of raw St widgets instead of the stock PopupMenu text-item
 * list. Horizontal agent tabs, a branded header, hero cost typography, inline
 * bar-chart activity rows, and a pill-styled footer -- same primitives GNOME's
 * own Quick Settings panel uses.
 *
 * Data source: `codeburn status --format menubar-json --period <p> --provider <pr>`,
 * polled every 60 seconds. Period, provider and currency are per-session state.
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const REFRESH_INTERVAL_SECONDS = 60;
const CACHE_TTL_MS = 60_000;
const TOP_ACTIVITIES = 5;
const CODEBURN_BIN = 'codeburn';

const PERIODS = [
    {id: 'today', label: 'Today'},
    {id: 'week', label: '7 Days'},
    {id: '30days', label: '30 Days'},
    {id: 'month', label: 'Month'},
    {id: 'all', label: 'All'},
];

// Secondary view pills (below period tabs, matches Mac popover). Each pill swaps
// the content area between Activity+Models and a dedicated insight view.
const INSIGHTS = [
    {id: 'activity', label: 'Activity'},
    {id: 'trend',    label: 'Trend'   },
    {id: 'forecast', label: 'Forecast'},
    {id: 'pulse',    label: 'Pulse'   },
    {id: 'stats',    label: 'Stats'   },
    {id: 'plan',     label: 'Plan'    },
];

const PROVIDERS = [
    {id: 'all', label: 'All'},
    {id: 'claude', label: 'Claude'},
    {id: 'codex', label: 'Codex'},
    {id: 'cursor', label: 'Cursor'},
    {id: 'copilot', label: 'Copilot'},
    {id: 'opencode', label: 'OpenCode'},
    {id: 'pi', label: 'Pi'},
];

const CURRENCIES = [
    {code: 'USD', symbol: '$'},
    {code: 'EUR', symbol: '€'},
    {code: 'GBP', symbol: '£'},
    {code: 'CAD', symbol: 'C$'},
    {code: 'AUD', symbol: 'A$'},
    {code: 'JPY', symbol: '¥'},
    {code: 'INR', symbol: '₹'},
    {code: 'BRL', symbol: 'R$'},
    {code: 'CHF', symbol: 'CHF '},
    {code: 'SEK', symbol: 'kr '},
    {code: 'SGD', symbol: 'S$'},
    {code: 'HKD', symbol: 'HK$'},
    {code: 'KRW', symbol: '₩'},
    {code: 'MXN', symbol: 'MX$'},
    {code: 'ZAR', symbol: 'R '},
    {code: 'DKK', symbol: 'kr '},
    {code: 'CNY', symbol: '¥'},
];

const CodeburnIndicator = GObject.registerClass(
class CodeburnIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'CodeBurn');

        this._period = 'today';
        this._insight = 'activity';
        this._availableProviders = this._detectAvailableProviders();
        // If only one provider is installed, use it directly so the popup doesn't
        // pretend to be filtering when there's nothing to filter. Otherwise start
        // on All so the user sees aggregate data.
        this._provider = this._availableProviders.length === 1 ? this._availableProviders[0] : 'all';
        this._currency = this._loadCurrency();
        this._fxRate = 1;
        this._fxCache = {USD: 1};
        this._soupSession = new Soup.Session();
        this._loading = false;
        this._refreshGen = 0;
        this._timeout = null;
        this._payload = null;
        // (period, provider) -> {payload, fetchedAt}. Matches the Mac AppStore
        // cache pattern. Tab switches within TTL render from memory immediately;
        // a background refresh silently replaces the cache when it returns.
        this._payloadCache = new Map();
        this._inFlightKeys = new Set();
        this._updateFxRate();

        this._themeSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._themeSignal = this._themeSettings.connect('changed::color-scheme', () => this._applyThemeClass());
        this._applyThemeClass();

        // Panel button: flame + live cost label
        const panel = new St.BoxLayout({style_class: 'panel-status-menu-box codeburn-panel'});
        this._flame = new St.Label({
            text: '🔥',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'codeburn-flame',
        });
        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'codeburn-label',
        });
        panel.add_child(this._flame);
        panel.add_child(this._label);
        this.add_child(panel);

        // Replace the default PopupMenu item list with a single container that we
        // paint with custom St widgets so the layout can be horizontal tabs + hero
        // + bar charts + footer, not a vertical text list.
        this.menu.box.add_style_class_name('codeburn-menu');
        this._popupHost = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._popupHost.add_style_class_name('codeburn-host');
        this.menu.addMenuItem(this._popupHost);

        this._root = new St.BoxLayout({
            vertical: true,
            style_class: 'codeburn-root',
            x_expand: true,
        });
        this._popupHost.add_child(this._root);

        this._buildBrandHeader();
        this._buildAgentTabs();
        this._buildHero();
        this._buildPeriodTabs();
        this._buildInsightPills();
        this._buildTokenChart();
        this._buildContentArea();
        this._buildFindingsSection();
        this._buildFooter();

        this._refresh();
        this._timeout = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            REFRESH_INTERVAL_SECONDS,
            () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            },
        );
    }

    _buildBrandHeader() {
        const header = new St.BoxLayout({vertical: true, style_class: 'codeburn-brand-header'});
        const title = new St.BoxLayout({style_class: 'codeburn-brand-row'});
        const titleLeft = new St.Label({text: 'Code', style_class: 'codeburn-brand-primary'});
        const titleRight = new St.Label({text: 'Burn', style_class: 'codeburn-brand-accent'});
        title.add_child(titleLeft);
        title.add_child(titleRight);
        const subhead = new St.Label({text: 'AI Coding Cost Tracker', style_class: 'codeburn-brand-subhead'});
        header.add_child(title);
        header.add_child(subhead);
        this._root.add_child(header);
    }

    _buildAgentTabs() {
        // Hide the tab row only when nothing is installed. A single provider
        // gets shown as a lone tab so the user still sees which agent the
        // numbers come from (no "mystery data" state). Multiple providers
        // get All + each detected tab in our preferred order.
        const detected = this._availableProviders;
        if (detected.length === 0) {
            this._agentTabs = new Map();
            return;
        }
        const tabs = detected.length === 1
            ? PROVIDERS.filter(p => p.id === detected[0])
            : [PROVIDERS[0], ...PROVIDERS.slice(1).filter(p => detected.includes(p.id))];

        // Single provider: render as a subtle pill badge (not a stretched button)
        // so it reads as an indicator, not a filter. Multiple providers: full
        // horizontal tab row with per-pill active state.
        if (tabs.length === 1) {
            const badge = new St.Label({
                text: tabs[0].label,
                style_class: 'codeburn-agent-badge',
            });
            const row = new St.BoxLayout({style_class: 'codeburn-tab-row'});
            row.add_child(badge);
            this._root.add_child(row);
            this._agentTabs = new Map();
            return;
        }

        const row = new St.BoxLayout({style_class: 'codeburn-tab-row'});
        this._agentTabs = new Map();
        for (const p of tabs) {
            const btn = new St.Button({
                label: p.label,
                style_class: 'codeburn-tab',
                can_focus: true,
                x_expand: true,
            });
            btn.connect('clicked', () => {
                this._provider = p.id;
                this._updateAgentTabStyle();
                this._refresh();
            });
            row.add_child(btn);
            this._agentTabs.set(p.id, btn);
        }
        this._root.add_child(row);
        this._updateAgentTabStyle();
    }

    /// Scan the home directory for provider session stores so the agent tab row
    /// can only offer providers the user actually runs. Checks file/dir existence
    /// only; the CLI still owns real "has usable data" semantics.
    _detectAvailableProviders() {
        const home = GLib.get_home_dir();
        const xdgData = GLib.getenv('XDG_DATA_HOME') || `${home}/.local/share`;
        const paths = {
            claude: `${home}/.claude/projects`,
            codex: `${home}/.codex/sessions`,
            cursor: `${home}/.config/Cursor/User/globalStorage/state.vscdb`,
            copilot: `${home}/.copilot/session-state`,
            opencode: `${xdgData}/opencode`,
            pi: `${home}/.pi/agent/sessions`,
        };
        const out = [];
        for (const [id, path] of Object.entries(paths)) {
            const file = Gio.File.new_for_path(path);
            if (file.query_exists(null)) out.push(id);
        }
        return out;
    }

    _updateAgentTabStyle() {
        for (const [id, btn] of this._agentTabs) {
            if (id === this._provider) btn.add_style_class_name('codeburn-tab-active');
            else btn.remove_style_class_name('codeburn-tab-active');
        }
    }

    _buildHero() {
        const hero = new St.BoxLayout({vertical: true, style_class: 'codeburn-hero'});
        const topLine = new St.BoxLayout({style_class: 'codeburn-hero-top'});
        this._heroDot = new St.Widget({style_class: 'codeburn-hero-dot'});
        this._heroLabel = new St.Label({text: 'Loading…', style_class: 'codeburn-hero-label'});
        topLine.add_child(this._heroDot);
        topLine.add_child(this._heroLabel);
        this._heroAmount = new St.Label({text: '$0.00', style_class: 'codeburn-hero-amount'});
        this._heroMeta = new St.Label({text: '', style_class: 'codeburn-hero-meta'});
        hero.add_child(topLine);
        hero.add_child(this._heroAmount);
        hero.add_child(this._heroMeta);
        this._root.add_child(hero);
    }

    _buildPeriodTabs() {
        const row = new St.BoxLayout({style_class: 'codeburn-tab-row codeburn-period-row'});
        this._periodTabs = new Map();
        for (const p of PERIODS) {
            const btn = new St.Button({
                label: p.label,
                style_class: 'codeburn-period',
                can_focus: true,
                x_expand: true,
            });
            btn.connect('clicked', () => {
                this._period = p.id;
                this._updatePeriodTabStyle();
                this._refresh();
            });
            row.add_child(btn);
            this._periodTabs.set(p.id, btn);
        }
        this._root.add_child(row);
        this._updatePeriodTabStyle();
    }

    _updatePeriodTabStyle() {
        for (const [id, btn] of this._periodTabs) {
            if (id === this._period) btn.add_style_class_name('codeburn-period-active');
            else btn.remove_style_class_name('codeburn-period-active');
        }
    }

    _buildInsightPills() {
        const row = new St.BoxLayout({style_class: 'codeburn-insight-row'});
        this._insightPills = new Map();
        for (const i of INSIGHTS) {
            const btn = new St.Button({
                label: i.label,
                style_class: 'codeburn-insight-pill',
                can_focus: true,
                x_expand: true,
            });
            btn.connect('clicked', () => {
                this._insight = i.id;
                this._updateInsightPillStyle();
                this._renderContent();
            });
            row.add_child(btn);
            this._insightPills.set(i.id, btn);
        }
        this._root.add_child(row);
        this._updateInsightPillStyle();
    }

    _updateInsightPillStyle() {
        for (const [id, btn] of this._insightPills) {
            if (id === this._insight) btn.add_style_class_name('codeburn-insight-pill-active');
            else btn.remove_style_class_name('codeburn-insight-pill-active');
        }
    }

    /// 19-day token histogram, matches the Mac Trend chart that sits below the
    /// hero. Each bar scales to the top-token day; colors come from the brand
    /// palette. Populated from payload.history.daily.
    _buildTokenChart() {
        const chart = new St.BoxLayout({vertical: true, style_class: 'codeburn-chart'});
        const header = new St.BoxLayout({style_class: 'codeburn-chart-header'});
        this._chartLabel = new St.Label({text: 'Tokens', style_class: 'codeburn-chart-label', x_expand: true});
        this._chartTotal = new St.Label({text: '', style_class: 'codeburn-chart-total'});
        header.add_child(this._chartLabel);
        header.add_child(this._chartTotal);
        chart.add_child(header);
        this._chartBars = new St.BoxLayout({style_class: 'codeburn-chart-bars'});
        chart.add_child(this._chartBars);
        this._root.add_child(chart);
    }

    /// Swappable content area: Activity (default), Trend, Forecast, Pulse,
    /// Stats, or Plan view — driven by this._insight.
    _buildContentArea() {
        this._contentArea = new St.BoxLayout({vertical: true, style_class: 'codeburn-content'});
        this._activityRows = new St.BoxLayout({vertical: true, style_class: 'codeburn-activity-rows'});
        this._modelsRows = new St.BoxLayout({vertical: true, style_class: 'codeburn-models-rows'});
        this._root.add_child(this._contentArea);
    }

    _buildFindingsSection() {
        this._findingsBtn = new St.Button({style_class: 'codeburn-findings', visible: false});
        const box = new St.BoxLayout({style_class: 'codeburn-findings-inner'});
        this._findingsCount = new St.Label({text: '', style_class: 'codeburn-findings-count'});
        this._findingsSavings = new St.Label({text: '', style_class: 'codeburn-findings-savings'});
        box.add_child(this._findingsCount);
        box.add_child(this._findingsSavings);
        this._findingsBtn.set_child(box);
        this._findingsBtn.connect('clicked', () => this._spawnTerminal([CODEBURN_BIN, 'optimize']));
        this._root.add_child(this._findingsBtn);
    }

    _buildFooter() {
        const footer = new St.BoxLayout({style_class: 'codeburn-footer'});

        this._currencyBtn = new St.Button({
            label: `${this._currency.code} ⌄`,
            style_class: 'codeburn-footer-btn codeburn-currency-btn',
            can_focus: true,
        });
        this._currencyBtn.connect('clicked', () => this._cycleCurrency());
        footer.add_child(this._currencyBtn);

        const refreshBtn = new St.Button({
            label: 'Refresh',
            style_class: 'codeburn-footer-btn',
            can_focus: true,
            x_expand: true,
        });
        refreshBtn.connect('clicked', () => this._refresh());
        footer.add_child(refreshBtn);

        const reportBtn = new St.Button({
            label: 'Open Full Report',
            style_class: 'codeburn-footer-btn codeburn-footer-cta',
            can_focus: true,
            x_expand: true,
        });
        reportBtn.connect('clicked', () => this._spawnTerminal([CODEBURN_BIN, 'report', '--period', this._period, '--provider', this._provider]));
        footer.add_child(reportBtn);

        this._root.add_child(footer);

        this._updatedLabel = new St.Label({text: '', style_class: 'codeburn-updated'});
        this._root.add_child(this._updatedLabel);
    }

    _cycleCurrency() {
        const idx = CURRENCIES.findIndex(c => c.code === this._currency.code);
        const next = CURRENCIES[(idx + 1) % CURRENCIES.length];
        this._setCurrency(next.code);
    }

    _loadCurrency() {
        const configPath = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'codeburn', 'config.json']);
        try {
            const [ok, contents] = GLib.file_get_contents(configPath);
            if (ok) {
                const config = JSON.parse(new TextDecoder().decode(contents));
                if (config.currency?.code) {
                    const known = CURRENCIES.find(c => c.code === config.currency.code);
                    if (known) return known;
                    return {code: config.currency.code, symbol: config.currency.symbol || `${config.currency.code} `};
                }
            }
        } catch (_) {
            // fall through to default
        }
        return CURRENCIES[0];
    }

    _setCurrency(code) {
        // The CLI command is fire-and-forget — it writes config.json. We don't wait
        // for it to finish because we already know the new code. Update the symbol
        // + FX rate immediately and re-render from the cached payload (values are
        // stored raw USD; formatCost applies the multiplier at render time). The
        // CLI call is still dispatched so other surfaces (TUI, menubar subcommand)
        // see the same currency on next run.
        try {
            Gio.Subprocess.new(
                [CODEBURN_BIN, 'currency', code],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            );
        } catch (_) {
            // CLI missing; we'll still update the local display.
        }
        const known = CURRENCIES.find(c => c.code === code);
        this._currency = known || {code, symbol: `${code} `};
        this._currencyBtn.set_label(`${this._currency.code} ⌄`);
        this._updateFxRate();
    }

    /// menubar-json payloads stay in USD regardless of the user's configured
    /// currency, so we apply the FX conversion client-side. Frankfurter serves
    /// the same ECB rates the CLI uses, cached per-session so a tab switch or
    /// a period switch doesn't hit the network again.
    _updateFxRate() {
        const code = this._currency?.code || 'USD';
        if (this._fxCache[code] !== undefined) {
            this._fxRate = this._fxCache[code];
            if (this._payload) this._render(this._payload);
            return;
        }
        const url = `https://api.frankfurter.app/latest?from=USD&to=${code}`;
        const msg = Soup.Message.new('GET', url);
        this._soupSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                if (!bytes) return;
                const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                const rate = json?.rates?.[code];
                if (typeof rate === 'number' && rate > 0) {
                    this._fxCache[code] = rate;
                    this._fxRate = rate;
                    if (this._payload) this._render(this._payload);
                }
            } catch (_) {
                // FX fetch failed; leave rate at previous value.
            }
        });
    }

    _cacheKey() {
        return `${this._period}|${this._provider}`;
    }

    /// Entry point for every tab/provider switch and the periodic poll.
    /// 1. If we have a fresh cached payload for the current (period, provider),
    ///    render immediately and return. Tab switches feel instant.
    /// 2. If a fetch for this same key is already in flight, don't spawn another.
    /// 3. Otherwise spawn a codeburn status subprocess; on return, cache the
    ///    payload and render. Uses a generation counter so a stale response from
    ///    a previous key doesn't clobber the current render.
    _refresh(force = false) {
        const key = this._cacheKey();
        const cached = this._payloadCache.get(key);
        if (!force && cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
            this._payload = cached.payload;
            this._render(this._payload);
            return;
        }
        if (this._inFlightKeys.has(key)) return;
        this._inFlightKeys.add(key);
        const gen = ++this._refreshGen;
        this._loading = true;

        let proc;
        try {
            proc = Gio.Subprocess.new(
                [CODEBURN_BIN, 'status', '--format', 'menubar-json', '--period', this._period, '--provider', this._provider],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            );
        } catch (_) {
            this._inFlightKeys.delete(key);
            this._loading = false;
            this._renderError('codeburn CLI not found on PATH');
            return;
        }

        proc.communicate_utf8_async(null, null, (p, result) => {
            this._inFlightKeys.delete(key);
            if (gen !== this._refreshGen) return;
            this._loading = false;
            try {
                const [ok, stdout, stderr] = p.communicate_utf8_finish(result);
                if (!ok) {
                    this._renderError(`codeburn failed: ${stderr || 'unknown error'}`);
                    return;
                }
                if (!stdout) {
                    this._renderError('codeburn returned no output');
                    return;
                }
                const payload = JSON.parse(stdout);
                this._payloadCache.set(key, {payload, fetchedAt: Date.now()});
                // Only render if the user is still on this key — if they switched
                // to a different period/provider while we were loading, the cache
                // entry stays warm but the UI already moved on.
                if (this._cacheKey() === key) {
                    this._payload = payload;
                    this._render(this._payload);
                }
            } catch (e) {
                this._renderError(`parse error: ${e.message}`);
            }
        });
    }

    _render(payload) {
        const current = payload?.current ?? {};
        const cost = Number(current.cost ?? 0);

        this._label.set_text(formatCost(cost, this._currency, this._fxRate));
        this._heroLabel.set_text(current.label || '');
        this._heroAmount.set_text(formatCost(cost, this._currency, this._fxRate));

        const calls = Number(current.calls ?? 0);
        const sessions = Number(current.sessions ?? 0);
        this._heroMeta.set_text(`${calls.toLocaleString()} calls   ${sessions} sessions`);

        this._renderChart(payload?.history?.daily ?? []);
        this._renderContent();
        this._renderFindings(payload?.optimize ?? {});

        const updated = payload?.generated ? formatTime(new Date(payload.generated)) : '';
        this._updatedLabel.set_text(updated ? `Updated ${updated}` : '');
    }

    _renderChart(daily) {
        this._chartBars.destroy_all_children();
        const days = Array.isArray(daily) ? daily.slice(-19) : [];
        if (days.length === 0) {
            this._chartTotal.set_text('no history yet');
            return;
        }
        const totals = days.map(d => {
            const input = Number(d?.inputTokens) || 0;
            const output = Number(d?.outputTokens) || 0;
            const cacheR = Number(d?.cacheReadTokens) || 0;
            const cacheW = Number(d?.cacheWriteTokens) || 0;
            return input + output + cacheR + cacheW;
        });
        let maxTotal = 1;
        let totalAll = 0;
        for (const t of totals) {
            if (t > maxTotal) maxTotal = t;
            totalAll += t;
        }
        this._chartTotal.set_text(`${formatTokensCompact(totalAll)} tokens`);
        const CHART_HEIGHT = 52;
        const BAR_WIDTH = 12;
        for (let i = 0; i < days.length; i++) {
            const h = Math.max(2, Math.round((totals[i] / maxTotal) * CHART_HEIGHT));
            const col = new St.BoxLayout({vertical: true, style_class: 'codeburn-chart-col'});
            const spacer = new St.Widget({style_class: 'codeburn-chart-spacer'});
            spacer.set_height(CHART_HEIGHT - h);
            const bar = new St.Widget({style_class: 'codeburn-chart-bar'});
            bar.set_width(BAR_WIDTH);
            bar.set_height(h);
            col.add_child(spacer);
            col.add_child(bar);
            this._chartBars.add_child(col);
        }
    }

    _renderContent() {
        this._contentArea.destroy_all_children();
        switch (this._insight) {
            case 'trend':    return this._renderTrendView();
            case 'forecast': return this._renderForecastView();
            case 'pulse':    return this._renderPulseView();
            case 'stats':    return this._renderStatsView();
            case 'plan':     return this._renderPlanView();
            default:         return this._renderActivityView();
        }
    }

    _renderActivityView() {
        const current = this._payload?.current ?? {};
        this._contentArea.add_child(this._sectionTitle('Activity'));
        const rows = new St.BoxLayout({vertical: true, style_class: 'codeburn-activity-rows'});
        const activities = Array.isArray(current.topActivities) ? current.topActivities : [];
        if (!activities.length) {
            rows.add_child(new St.Label({text: 'No activity for this period', style_class: 'codeburn-empty'}));
        } else {
            const maxCost = activities.reduce((m, a) => Math.max(m, Number(a.cost) || 0), 0) || 1;
            for (const a of activities.slice(0, TOP_ACTIVITIES)) {
                rows.add_child(this._buildActivityRow(a, maxCost));
            }
        }
        this._contentArea.add_child(rows);

        const models = Array.isArray(current.topModels) ? current.topModels : [];
        if (models.length) {
            this._contentArea.add_child(this._sectionTitle('Models'));
            const mrows = new St.BoxLayout({vertical: true, style_class: 'codeburn-models-rows'});
            for (const m of models.slice(0, 3)) {
                mrows.add_child(this._buildModelRow(m));
            }
            this._contentArea.add_child(mrows);
        }
    }

    _renderTrendView() {
        const daily = this._payload?.history?.daily ?? [];
        this._contentArea.add_child(this._sectionTitle('Trend'));
        if (!daily.length) {
            this._contentArea.add_child(new St.Label({text: 'Not enough history yet', style_class: 'codeburn-empty'}));
            return;
        }
        const recent = daily.slice(-7).reverse();
        for (const d of recent) {
            const row = new St.BoxLayout({style_class: 'codeburn-trend-row'});
            row.add_child(new St.Label({text: d.date, style_class: 'codeburn-trend-date', x_expand: true}));
            row.add_child(new St.Label({text: formatCost(d.cost, this._currency, this._fxRate), style_class: 'codeburn-trend-cost'}));
            row.add_child(new St.Label({text: `${Number(d.calls).toLocaleString()} calls`, style_class: 'codeburn-trend-calls'}));
            this._contentArea.add_child(row);
        }
    }

    _renderForecastView() {
        const daily = this._payload?.history?.daily ?? [];
        this._contentArea.add_child(this._sectionTitle('Forecast'));
        if (daily.length < 3) {
            this._contentArea.add_child(new St.Label({text: 'Need at least 3 days of history', style_class: 'codeburn-empty'}));
            return;
        }
        const last7 = daily.slice(-7);
        const avg = last7.reduce((s, d) => s + Number(d.cost || 0), 0) / last7.length;
        const today = daily.at(-1);
        const yesterday = daily.at(-2);
        const wowDelta = yesterday ? ((Number(today.cost || 0) - Number(yesterday.cost || 0)) / Math.max(Number(yesterday.cost || 0), 1)) * 100 : 0;
        const now = new Date();
        const dayOfMonth = now.getUTCDate();
        const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
        const monthProjection = avg * daysInMonth;

        this._contentArea.add_child(this._kvRow('7-day avg', formatCost(avg, this._currency, this._fxRate)));
        this._contentArea.add_child(this._kvRow('Yesterday', yesterday ? formatCost(yesterday.cost, this._currency, this._fxRate) : '-'));
        this._contentArea.add_child(this._kvRow('Day-over-day', `${wowDelta > 0 ? '+' : ''}${wowDelta.toFixed(1)}%`));
        this._contentArea.add_child(this._kvRow('Month projection', formatCost(monthProjection, this._currency, this._fxRate)));
        this._contentArea.add_child(this._kvRow('Days elapsed', `${dayOfMonth} of ${daysInMonth}`));
    }

    _renderPulseView() {
        const current = this._payload?.current ?? {};
        const daily = this._payload?.history?.daily ?? [];
        this._contentArea.add_child(this._sectionTitle('Pulse'));
        const row = new St.BoxLayout({style_class: 'codeburn-pulse-row'});
        row.add_child(this._pulseTile(formatCost(current.cost, this._currency, this._fxRate), 'cost'));
        row.add_child(this._pulseTile(Number(current.calls || 0).toLocaleString(), 'calls'));
        row.add_child(this._pulseTile(`${Number(current.cacheHitPercent || 0).toFixed(0)}%`, 'cache hit'));
        this._contentArea.add_child(row);
        // Last 7 days mini
        if (daily.length) {
            this._contentArea.add_child(this._sectionTitle('Last 7 days'));
            const last7 = daily.slice(-7);
            const sumCost = last7.reduce((s, d) => s + Number(d.cost || 0), 0);
            const sumCalls = last7.reduce((s, d) => s + Number(d.calls || 0), 0);
            const peakDay = last7.reduce((best, d) => Number(d.cost || 0) > Number(best.cost || 0) ? d : best, last7[0]);
            this._contentArea.add_child(this._kvRow('Total spend', formatCost(sumCost, this._currency, this._fxRate)));
            this._contentArea.add_child(this._kvRow('Total calls', Number(sumCalls).toLocaleString()));
            this._contentArea.add_child(this._kvRow('Peak day', `${peakDay?.date || '-'}   ${formatCost(peakDay?.cost, this._currency, this._fxRate)}`));
        }
    }

    _renderStatsView() {
        const current = this._payload?.current ?? {};
        const daily = this._payload?.history?.daily ?? [];
        this._contentArea.add_child(this._sectionTitle('Stats'));
        const models = Array.isArray(current.topModels) ? current.topModels : [];
        const favModel = models[0]?.name ?? '-';
        const activeDays = daily.filter(d => Number(d.cost || 0) > 0).length;
        const peakDay = daily.reduce((best, d) => Number(d.cost || 0) > Number((best || {}).cost || 0) ? d : best, null);
        // Simple streak: consecutive recent non-zero days
        let streak = 0;
        for (let i = daily.length - 1; i >= 0; i--) {
            if (Number(daily[i].cost || 0) > 0) streak++; else break;
        }
        this._contentArea.add_child(this._kvRow('Favorite model', favModel));
        this._contentArea.add_child(this._kvRow('Active days', `${activeDays}`));
        this._contentArea.add_child(this._kvRow('Current streak', `${streak} days`));
        if (peakDay) {
            this._contentArea.add_child(this._kvRow('Peak day', `${peakDay.date}   ${formatCost(peakDay.cost, this._currency, this._fxRate)}`));
        }
    }

    _renderPlanView() {
        this._contentArea.add_child(this._sectionTitle('Plan'));
        const msg = new St.Label({
            text: 'Claude OAuth subscription tracking is macOS-only for now. Coming to Linux in a future release.',
            style_class: 'codeburn-empty',
            x_expand: true,
        });
        msg.clutter_text.line_wrap = true;
        msg.clutter_text.line_wrap_mode = Pango.WrapMode.WORD;
        msg.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._contentArea.add_child(msg);
    }

    _sectionTitle(text) {
        return new St.Label({text, style_class: 'codeburn-section-title'});
    }

    _kvRow(label, value) {
        const row = new St.BoxLayout({style_class: 'codeburn-kv-row'});
        row.add_child(new St.Label({text: label, style_class: 'codeburn-kv-label', x_expand: true}));
        row.add_child(new St.Label({text: String(value ?? '-'), style_class: 'codeburn-kv-value'}));
        return row;
    }

    _pulseTile(value, label) {
        const tile = new St.BoxLayout({vertical: true, style_class: 'codeburn-pulse-tile', x_expand: true});
        tile.add_child(new St.Label({text: value, style_class: 'codeburn-pulse-value'}));
        tile.add_child(new St.Label({text: label, style_class: 'codeburn-pulse-label'}));
        return tile;
    }

    _buildModelRow(model) {
        const row = new St.BoxLayout({style_class: 'codeburn-model-row'});
        row.add_child(new St.Label({text: model.name, style_class: 'codeburn-model-name', x_expand: true}));
        row.add_child(new St.Label({text: formatCost(model.cost, this._currency, this._fxRate), style_class: 'codeburn-model-cost'}));
        row.add_child(new St.Label({text: `${Number(model.calls || 0).toLocaleString()}`, style_class: 'codeburn-model-calls'}));
        return row;
    }

    _buildActivityRow(activity, maxCost) {
        const row = new St.BoxLayout({vertical: true, style_class: 'codeburn-activity-row'});

        const topLine = new St.BoxLayout({style_class: 'codeburn-activity-top'});
        const name = new St.Label({
            text: activity.name,
            style_class: 'codeburn-activity-name',
            x_expand: true,
        });
        const cost = new St.Label({
            text: formatCost(activity.cost, this._currency, this._fxRate),
            style_class: 'codeburn-activity-cost',
        });
        const turns = new St.Label({
            text: `${Number(activity.turns) || 0}t`,
            style_class: 'codeburn-activity-turns',
        });
        topLine.add_child(name);
        topLine.add_child(cost);
        topLine.add_child(turns);
        if (activity.oneShotRate !== null && activity.oneShotRate !== undefined) {
            const oneShot = new St.Label({
                text: `${Math.round(Number(activity.oneShotRate) * 100)}%`,
                style_class: 'codeburn-activity-oneshot',
            });
            topLine.add_child(oneShot);
        }
        row.add_child(topLine);

        // Bar chart: proportional to this activity's share of the top cost. The
        // track is a BoxLayout so the fill child lays out horizontally instead of
        // stretching to fill the parent (which made every bar look 100%).
        const track = new St.BoxLayout({style_class: 'codeburn-bar-track'});
        const filledPct = Math.max(0.02, Math.min(1, Number(activity.cost) / maxCost));
        const fill = new St.Widget({style_class: 'codeburn-bar-fill'});
        fill.set_width(Math.round(240 * filledPct));
        track.add_child(fill);
        row.add_child(track);

        return row;
    }

    _renderFindings(optimize) {
        const count = Number(optimize?.findingCount ?? 0);
        if (count === 0) {
            this._findingsBtn.hide();
            return;
        }
        const savings = Number(optimize?.savingsUSD ?? 0);
        this._findingsCount.set_text(`⚠  ${count} optimize findings`);
        this._findingsSavings.set_text(`save ~${formatCost(savings, this._currency, this._fxRate)}`);
        this._findingsBtn.show();
    }

    _renderError(message) {
        this._label.set_text('!');
        this._heroLabel.set_text(message);
        this._heroAmount.set_text('');
        this._heroMeta.set_text('');
        this._activityRows.destroy_all_children();
        this._findingsBtn.hide();
    }

    _spawnTerminal(argv) {
        const command = `${argv.join(' ')}; echo; read -n 1 -s -r -p 'Press any key to close...'`;
        try {
            Gio.Subprocess.new(
                ['gnome-terminal', '--', 'bash', '-lc', command],
                Gio.SubprocessFlags.NONE,
            );
        } catch (e) {
            log(`codeburn: terminal spawn error: ${e.message}`);
        }
        this.menu.close();
    }

    _applyThemeClass() {
        const scheme = this._themeSettings.get_string('color-scheme');
        const isDark = scheme === 'prefer-dark';
        this.add_style_class_name(isDark ? 'codeburn-dark' : 'codeburn-light');
        this.remove_style_class_name(isDark ? 'codeburn-light' : 'codeburn-dark');
    }

    destroy() {
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = null;
        }
        if (this._themeSettings && this._themeSignal) {
            this._themeSettings.disconnect(this._themeSignal);
            this._themeSignal = null;
            this._themeSettings = null;
        }
        super.destroy();
    }
});

function formatCost(value, currency, rate = 1) {
    const n = (Number(value) || 0) * (Number(rate) || 1);
    const abs = Math.abs(n);
    const symbol = currency?.symbol || '$';
    if (abs >= 1000) {
        return `${symbol}${(n / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
    }
    return `${symbol}${n.toFixed(2)}`;
}

function formatTokensCompact(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
    if (v >= 1_000_000)     return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1000)          return `${(v / 1000).toFixed(1)}k`;
    return String(v);
}

function formatTime(date) {
    if (!date || Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (diffSec < 60) return 'just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return date.toLocaleDateString();
}

export default class CodeburnExtension extends Extension {
    enable() {
        this._indicator = new CodeburnIndicator();
        Main.panel.addToStatusArea('codeburn', this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
