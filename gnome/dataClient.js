import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const TIMEOUT_SECONDS = 15;
const SAFE_ARG_RE = /^[A-Za-z0-9 ._/\-]+$/;

function isCombinedDetailsUnsupported(error) {
  return /unknown option[^\n]*--combined-details/i.test(error?.message || '');
}

function buildAdditionalPaths() {
  const home = GLib.get_home_dir();
  return [
    '/usr/local/bin',
    `${home}/.local/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.volta/bin`,
    `${home}/.bun/bin`,
    `${home}/.cargo/bin`,
    `${home}/.asdf/shims`,
    `${home}/.local/share/fnm/aliases/default/bin`,
    `${home}/.local/share/pnpm`,
  ];
}

export class DataClient {
  _cache = new Map();
  _inFlight = null;
  _combinedDetailsSupported = null;
  _codeburnPath;
  _augmentedPath;

  constructor(codeburnPath) {
    this._codeburnPath = codeburnPath || '';
    this._augmentedPath = this._buildAugmentedPath();
  }

  setCodeburnPath(path) {
    this._codeburnPath = path || '';
    this._combinedDetailsSupported = null;
  }

  cancelInFlight() {
    if (this._inFlight) {
      this._inFlight.cancellable.cancel();
      this._inFlight = null;
    }
  }

  getCached(period, provider, scope = 'local') {
    const key = `${scope}:${period}:${provider}`;
    return this._cache.get(key) ?? null;
  }

  async fetch(period, provider, scope = 'local') {
    this.cancelInFlight();

    const cancellable = new Gio.Cancellable();
    this._inFlight = { cancellable };

    try {
      let payload;
      if (scope === 'combined' && this._combinedDetailsSupported !== false) {
        try {
          payload = await this._spawn(period, provider, scope, cancellable, true);
          this._combinedDetailsSupported = true;
        } catch (e) {
          // Keep the extension usable with an older globally installed CLI.
          // It can still provide combined totals, but does not know how to
          // emit the optional detailed per-device payloads.
          if (!isCombinedDetailsUnsupported(e)) throw e;
          this._combinedDetailsSupported = false;
          payload = await this._spawn(period, provider, scope, cancellable, false);
        }
      } else {
        payload = await this._spawn(period, provider, scope, cancellable, false);
      }
      const key = `${scope}:${period}:${provider}`;
      this._cache.set(key, payload);
      return payload;
    } finally {
      if (this._inFlight?.cancellable === cancellable)
        this._inFlight = null;
    }
  }

  _buildArgv(period, provider, scope = 'local', combinedDetails = true) {
    let base;
    if (this._codeburnPath && SAFE_ARG_RE.test(this._codeburnPath)) {
      base = this._codeburnPath.split(' ').filter(s => s.length > 0);
    } else {
      base = ['codeburn'];
    }

    const args = [
      ...base,
      'status',
      '--format', 'menubar-json',
      '--period', period,
      '--no-optimize',
    ];

    // Combined usage is intentionally unfiltered: paired devices expose
    // aggregate all-provider data, and the CLI rejects scoped combinations.
    if (scope === 'combined') {
      args.push('--scope', 'combined');
      if (combinedDetails) args.push('--combined-details');
    } else if (provider && provider !== 'all') {
      args.push('--provider', provider);
    }

    return args;
  }

  _buildAugmentedPath() {
    const currentPath = GLib.getenv('PATH') || '/usr/bin:/bin';
    const parts = currentPath.split(':');
    for (const extra of buildAdditionalPaths()) {
      if (!parts.includes(extra))
        parts.push(extra);
    }
    return parts.join(':');
  }

  _spawn(period, provider, scope, cancellable, combinedDetails = true) {
    return new Promise((resolve, reject) => {
      const argv = this._buildArgv(period, provider, scope, combinedDetails);
      let settled = false;

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      let proc;
      try {
        const launcher = Gio.SubprocessLauncher.new(
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );
        launcher.setenv('PATH', this._augmentedPath, true);
        proc = launcher.spawnv(argv);
      } catch (e) {
        settle(reject, new Error(`CLI not found: ${e.message}`));
        return;
      }

      let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMEOUT_SECONDS, () => {
        timeoutId = 0;
        proc.force_exit();
        settle(reject, new Error('CLI timeout'));
        return GLib.SOURCE_REMOVE;
      });

      proc.communicate_utf8_async(null, cancellable, (_proc, res) => {
        if (timeoutId) {
          GLib.Source.remove(timeoutId);
          timeoutId = 0;
        }

        try {
          const [, stdout, stderr] = _proc.communicate_utf8_finish(res);

          if (!_proc.get_successful()) {
            const msg = stderr?.trim() || 'CLI exited with error';
            settle(reject, new Error(msg));
            return;
          }

          if (!stdout || stdout.trim().length === 0) {
            settle(reject, new Error('CLI returned empty output'));
            return;
          }

          const payload = JSON.parse(stdout);
          settle(resolve, payload);
        } catch (e) {
          settle(reject, e);
        }
      });
    });
  }

  destroy() {
    this.cancelInFlight();
    this._cache.clear();
    this._combinedDetailsSupported = null;
  }
}
