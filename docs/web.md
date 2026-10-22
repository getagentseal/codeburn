# Browser dashboard

```bash
codeburn web                    # opens http://localhost:4747 in your browser
codeburn web -p 30days          # start on a different period
codeburn web --port 8080        # pick a port (falls back to a free one if taken)
codeburn web --no-open          # start the server without opening a browser
```

A local web dashboard with the same task, model, tool, and project breakdowns as the TUI, rendered with charts. The usage graph follows the selected period with 15-minute, hourly, or daily buckets and can switch between per-session and per-model lines. Everything is read from disk on your machine and the server binds to localhost; nothing is uploaded.

## Behind a reverse proxy

The dashboard has no login of its own, and the local view shows project names,
paths and session detail. So by default it listens on `127.0.0.1` and refuses
any request whose `Host` or `Origin` is not a loopback name. That stops DNS
rebinding and cross-site requests.

To reach it from another machine, put it behind a reverse proxy **that
authenticates**, such as oauth2-proxy, Authelia or your SSO's forward auth, and
name the hostname the proxy serves it under:

```bash
codeburn web --no-open --host 0.0.0.0 --port 4747 --allowed-host usage.example.org
```

- `--host` is the address to listen on.
- `--allowed-host` is repeatable. It is matched exactly and case-insensitively,
  without the port, against both `Host` and `Origin`. Everything else still
  gets a 403.
- Allow the port only from the proxy, with a firewall, because anyone who
  reaches it directly and sends the allowed `Host` gets the full dashboard.

## Combine usage across your devices

See one total across your laptop, desktop, and work machine on the same network. On each other device, share its usage:

```bash
codeburn share --pair           # opens a pairing window and prints a PIN
```

Then add it once from your main device (the PIN authorizes the pairing):

```bash
codeburn devices add            # find nearby devices and pair, or: add <host> --pin <pin>
codeburn devices                # combined totals by machine
codeburn devices rm <name>      # forget a device
```

Pairing is PIN-authorized and stays on your local network. You can also discover and pair devices straight from the browser dashboard.

