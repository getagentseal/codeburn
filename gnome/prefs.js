import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PROVIDERS = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'copilot', label: 'Copilot' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'droid', label: 'Droid' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'goose', label: 'Goose' },
  { id: 'kilo-code', label: 'Kilo Code' },
  { id: 'kiro', label: 'Kiro' },
  { id: 'openclaw', label: 'OpenClaw' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'pi', label: 'Pi' },
  { id: 'qwen', label: 'Qwen' },
  { id: 'roo-code', label: 'Roo Code' },
  { id: 'antigravity', label: 'Antigravity' },
];

const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: '7 Days' },
  { id: '30days', label: '30 Days' },
  { id: 'month', label: 'Month' },
  { id: 'all', label: 'All Time' },
];

export default class CodeBurnPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    const displayPage = new Adw.PreferencesPage({
      title: 'Display',
      icon_name: 'preferences-desktop-display-symbolic',
    });
    window.add(displayPage);

    const displayGroup = new Adw.PreferencesGroup({
      title: 'Display',
      description: 'Configure how CodeBurn appears in the panel',
    });
    displayPage.add(displayGroup);

    const refreshRow = new Adw.SpinRow({
      title: 'Refresh Interval',
      subtitle: 'Seconds between data refreshes',
      adjustment: new Gtk.Adjustment({
        lower: 5,
        upper: 300,
        step_increment: 5,
        page_increment: 30,
        value: settings.get_uint('refresh-interval'),
      }),
    });
    settings.bind('refresh-interval', refreshRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    displayGroup.add(refreshRow);

    const compactRow = new Adw.SwitchRow({
      title: 'Compact Mode',
      subtitle: 'Show only the icon, hide the cost label',
    });
    settings.bind('compact-mode', compactRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    displayGroup.add(compactRow);

    const darkModeRow = new Adw.SwitchRow({
      title: 'Force Dark Mode',
      subtitle: 'Always use dark theme for the popup',
    });
    settings.bind('force-dark-mode', darkModeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    displayGroup.add(darkModeRow);

    const exactCostsRow = new Adw.SwitchRow({
      title: 'Show Exact Costs',
      subtitle: 'Show full values like $2,655.23 instead of $2.7k',
    });
    settings.bind('show-exact-costs', exactCostsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    displayGroup.add(exactCostsRow);

    const periodModel = new Gtk.StringList();
    for (const p of PERIODS)
      periodModel.append(p.label);

    const periodRow = new Adw.ComboRow({
      title: 'Default Period',
      subtitle: 'Time period shown when extension opens',
      model: periodModel,
    });
    const currentPeriod = settings.get_string('default-period');
    const periodIndex = PERIODS.findIndex(p => p.id === currentPeriod);
    periodRow.set_selected(periodIndex >= 0 ? periodIndex : 0);
    periodRow.connect('notify::selected', () => {
      const idx = periodRow.get_selected();
      if (idx >= 0 && idx < PERIODS.length)
        settings.set_string('default-period', PERIODS[idx].id);
    });
    displayGroup.add(periodRow);

    const alertsGroup = new Adw.PreferencesGroup({
      title: 'Budget Alerts',
      description: 'Get warned when spending exceeds a threshold',
    });
    displayPage.add(alertsGroup);

    const budgetEnabledRow = new Adw.SwitchRow({
      title: 'Enable Budget Alerts',
      subtitle: 'Show a warning when daily spending exceeds the threshold',
    });
    settings.bind('budget-alert-enabled', budgetEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    alertsGroup.add(budgetEnabledRow);

    const budgetRow = new Adw.SpinRow({
      title: 'Daily Budget (USD)',
      subtitle: 'Set to 0 to disable',
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 1000,
        step_increment: 1,
        page_increment: 10,
        value: settings.get_double('budget-threshold'),
      }),
      digits: 2,
    });
    settings.bind('budget-threshold', budgetRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    alertsGroup.add(budgetRow);

    const providersGroup = new Adw.PreferencesGroup({
      title: 'Providers',
      description: 'Toggle providers on/off for cost accounting',
    });
    displayPage.add(providersGroup);

    const disabledProviders = settings.get_strv('disabled-providers');

    for (const provider of PROVIDERS) {
      const row = new Adw.SwitchRow({
        title: provider.label,
        active: !disabledProviders.includes(provider.id),
      });
      row.connect('notify::active', () => {
        const current = settings.get_strv('disabled-providers');
        if (row.get_active()) {
          settings.set_strv('disabled-providers', current.filter(p => p !== provider.id));
        } else {
          if (!current.includes(provider.id))
            settings.set_strv('disabled-providers', [...current, provider.id]);
        }
      });
      providersGroup.add(row);
    }

    const advancedGroup = new Adw.PreferencesGroup({
      title: 'Advanced',
    });
    displayPage.add(advancedGroup);

    const pathRow = new Adw.EntryRow({
      title: 'CodeBurn CLI Path',
      text: settings.get_string('codeburn-path'),
    });
    pathRow.connect('changed', () => {
      settings.set_string('codeburn-path', pathRow.get_text());
    });
    advancedGroup.add(pathRow);
  }
}
