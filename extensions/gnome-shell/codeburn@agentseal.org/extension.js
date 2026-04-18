/*
 * CodeBurn GNOME Shell extension.
 *
 * Renders a flame + current-period cost label in the top panel and opens a native
 * PopupMenu on click. Unlike the Tauri tray app (desktop/), this lives inside
 * gnome-shell so it can anchor the popover directly under the panel button,
 * matching Ubuntu's Quick Settings feel.
 *
 * Data source: `codeburn status --format menubar-json --period <p>`, polled every
 * 60s. The period is a per-session preference held in memory on the indicator.
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const REFRESH_INTERVAL_SECONDS = 60;
const TOP_ACTIVITIES = 5;
const TOP_MODELS = 3;
const TOP_PROVIDERS = 4;
const CODEBURN_BIN = 'codeburn';

const PERIODS = [
    {id: 'today', label: 'Today'},
    {id: 'week', label: '7 Days'},
    {id: '30days', label: '30 Days'},
    {id: 'month', label: 'Month'},
    {id: 'all', label: 'All Time'},
];

const CodeburnIndicator = GObject.registerClass(
class CodeburnIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'CodeBurn');

        this._period = 'today';
        this._loading = false;
        this._timeout = null;
        this._payload = null;

        // Follow the GNOME system color-scheme so the popup stays readable on both
        // light and dark themes. Adds .codeburn-dark / .codeburn-light to the root
        // widget so stylesheet.css can tweak per-theme without fighting the shell's
        // inherited palette.
        this._themeSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._themeSignal = this._themeSettings.connect('changed::color-scheme', () => this._applyThemeClass());
        this._applyThemeClass();

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box codeburn-panel'});
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
        box.add_child(this._flame);
        box.add_child(this._label);
        this.add_child(box);

        this._buildMenu();

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

    _buildMenu() {
        // Header: period + hero cost + calls + sessions
        this._headerItem = new PopupMenu.PopupMenuItem('Loading…', {reactive: false});
        this._headerItem.label.style_class = 'codeburn-header';
        this.menu.addMenuItem(this._headerItem);

        this._metaItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._metaItem.label.style_class = 'codeburn-meta';
        this.menu.addMenuItem(this._metaItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Period switcher submenu
        this._periodSubmenu = new PopupMenu.PopupSubMenuMenuItem(this._periodLabel());
        for (const p of PERIODS) {
            const item = new PopupMenu.PopupMenuItem(p.label);
            item.connect('activate', () => {
                this._period = p.id;
                this._periodSubmenu.label.set_text(this._periodLabel());
                this._refresh();
            });
            this._periodSubmenu.menu.addMenuItem(item);
        }
        this.menu.addMenuItem(this._periodSubmenu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Activities, models, providers, findings (populated on render)
        this._activitySection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._activitySection);

        this._modelsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._modelsSection);

        this._providersSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._providersSection);

        this._findingsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._findingsSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Footer: updated timestamp, refresh, open full report
        this._updatedItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._updatedItem.label.style_class = 'codeburn-updated';
        this.menu.addMenuItem(this._updatedItem);

        const refresh = new PopupMenu.PopupMenuItem('Refresh');
        refresh.connect('activate', () => this._refresh());
        this.menu.addMenuItem(refresh);

        const openReport = new PopupMenu.PopupMenuItem('Open Full Report');
        openReport.connect('activate', () => this._spawnTerminal([CODEBURN_BIN, 'report', '--period', this._period]));
        this.menu.addMenuItem(openReport);
    }

    _periodLabel() {
        const p = PERIODS.find(x => x.id === this._period);
        return `Period · ${p ? p.label : this._period}`;
    }

    _refresh() {
        if (this._loading) return;
        this._loading = true;
        this._headerItem.label.set_text(this._payload ? this._headerItem.label.get_text() : 'Loading…');

        let proc;
        try {
            proc = Gio.Subprocess.new(
                [CODEBURN_BIN, 'status', '--format', 'menubar-json', '--period', this._period],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            );
        } catch (e) {
            this._loading = false;
            this._renderError('codeburn CLI not found on PATH. Install the npm package first.');
            return;
        }

        proc.communicate_utf8_async(null, null, (p, result) => {
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
                this._payload = payload;
                this._render(payload);
            } catch (e) {
                this._renderError(`parse error: ${e.message}`);
            }
        });
    }

    _render(payload) {
        const current = payload?.current ?? {};
        const cost = Number(current.cost ?? 0);
        const formatted = formatUsd(cost);

        this._label.set_text(formatted);

        const label = current.label ?? '';
        const calls = Number(current.calls ?? 0);
        const sessions = Number(current.sessions ?? 0);
        const oneShot = current.oneShotRate;
        const cacheHit = Number(current.cacheHitPercent ?? 0);

        this._headerItem.label.set_text(`${label}   ${formatted}`);
        const metaParts = [
            `${calls.toLocaleString()} calls`,
            `${sessions} sessions`,
            `${cacheHit.toFixed(0)}% cache`,
        ];
        if (oneShot !== null && oneShot !== undefined) {
            metaParts.push(`${Math.round(Number(oneShot) * 100)}% 1-shot`);
        }
        this._metaItem.label.set_text(metaParts.join('   '));

        this._renderActivities(current.topActivities ?? []);
        this._renderModels(current.topModels ?? []);
        this._renderProviders(current.providers ?? {});
        this._renderFindings(payload?.optimize ?? {});

        const updated = payload?.generated ? formatTime(new Date(payload.generated)) : '';
        this._updatedItem.label.set_text(updated ? `Updated ${updated}` : '');
    }

    _renderActivities(activities) {
        this._activitySection.removeAll();
        if (!activities.length) {
            const empty = new PopupMenu.PopupMenuItem('No activity for this period', {reactive: false});
            empty.label.style_class = 'codeburn-empty';
            this._activitySection.addMenuItem(empty);
            return;
        }
        const title = new PopupMenu.PopupMenuItem('Activity', {reactive: false});
        title.label.style_class = 'codeburn-section-title';
        this._activitySection.addMenuItem(title);
        for (const a of activities.slice(0, TOP_ACTIVITIES)) {
            const oneShot = a.oneShotRate;
            const tail = oneShot == null
                ? `${a.turns} turns`
                : `${a.turns} turns   ${Math.round(Number(oneShot) * 100)}% 1-shot`;
            const line = `  ${a.name.padEnd(14)} ${formatUsd(a.cost).padStart(8)}   ${tail}`;
            const item = new PopupMenu.PopupMenuItem(line, {reactive: false});
            item.label.style_class = 'codeburn-row';
            this._activitySection.addMenuItem(item);
        }
    }

    _renderModels(models) {
        this._modelsSection.removeAll();
        if (!models.length) return;
        const title = new PopupMenu.PopupMenuItem('Models', {reactive: false});
        title.label.style_class = 'codeburn-section-title';
        this._modelsSection.addMenuItem(title);
        for (const m of models.slice(0, TOP_MODELS)) {
            const calls = Number(m.calls ?? 0).toLocaleString();
            const line = `  ${m.name.padEnd(18)} ${formatUsd(m.cost).padStart(8)}   ${calls} calls`;
            const item = new PopupMenu.PopupMenuItem(line, {reactive: false});
            item.label.style_class = 'codeburn-row';
            this._modelsSection.addMenuItem(item);
        }
    }

    _renderProviders(providers) {
        this._providersSection.removeAll();
        const entries = Object.entries(providers).filter(([, cost]) => Number(cost) > 0);
        if (entries.length <= 1) return;
        entries.sort((a, b) => Number(b[1]) - Number(a[1]));
        const title = new PopupMenu.PopupMenuItem('Providers', {reactive: false});
        title.label.style_class = 'codeburn-section-title';
        this._providersSection.addMenuItem(title);
        for (const [name, cost] of entries.slice(0, TOP_PROVIDERS)) {
            const line = `  ${capitalize(name).padEnd(14)} ${formatUsd(Number(cost)).padStart(8)}`;
            const item = new PopupMenu.PopupMenuItem(line, {reactive: false});
            item.label.style_class = 'codeburn-row';
            this._providersSection.addMenuItem(item);
        }
    }

    _renderFindings(optimize) {
        this._findingsSection.removeAll();
        const count = Number(optimize?.findingCount ?? 0);
        if (count === 0) return;
        const savings = Number(optimize?.savingsUSD ?? 0);
        const text = `⚠  ${count} optimize findings   save ~${formatUsd(savings)}`;
        const item = new PopupMenu.PopupMenuItem(text);
        item.label.style_class = 'codeburn-findings';
        item.connect('activate', () => this._spawnTerminal([CODEBURN_BIN, 'optimize']));
        this._findingsSection.addMenuItem(item);
    }

    _renderError(message) {
        this._label.set_text('!');
        this._headerItem.label.set_text(message);
        this._metaItem.label.set_text('');
        this._activitySection.removeAll();
        this._modelsSection.removeAll();
        this._providersSection.removeAll();
        this._findingsSection.removeAll();
    }

    _spawnTerminal(argv) {
        // Quote arguments into a single command string for bash -lc. argv here only ever
        // contains static identifiers from our own code so plain join is safe.
        const command = `${argv.join(' ')}; echo; read -n 1 -s -r -p 'Press any key to close...'`;
        try {
            Gio.Subprocess.new(
                ['gnome-terminal', '--', 'bash', '-lc', command],
                Gio.SubprocessFlags.NONE,
            );
        } catch (e) {
            log(`codeburn: terminal spawn error: ${e.message}`);
        }
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

function formatUsd(value) {
    const n = Number(value) || 0;
    const abs = Math.abs(n);
    if (abs >= 1000) {
        return `$${(n / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
    }
    return `$${n.toFixed(2)}`;
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

function capitalize(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
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
