#!/usr/bin/env python3
"""Usage Limits — multi-provider usage data, single source of truth.

Providers:
  claude   — Claude Code (sessionKey cookie + browser-like headers)
  codex    — Codex/ChatGPT Pro (JWT from ~/.codex/auth.json)
  cursor   — Cursor (workos cookie)
  gemini   — Gemini Code Assist (OAuth from Keychain or oauth_creds.json)
  kimi     — Kimi Code (CLI cookie)
  krater   — Krater.ai (cookies)
  opencode — OpenCode Go subscription (opencode.ai/workspace + cookie)
  ollama   — Ollama Cloud (ollama.com/settings + cookie)

Usage:
  python3 main.py                            # all providers, human output
  python3 main.py --json                     # JSON to stdout
  python3 main.py codex                      # single provider (positional)
  python3 main.py --json --write-cache       # also write JSON cache file
  python3 main.py --provider codex           # legacy flag form

Cache file: ~/Library/Application Support/CodeBurn/usage-limits.json
"""

import argparse, base64, json, os, re, shutil, subprocess, sys, time
import urllib.request, urllib.error
from datetime import datetime, timezone
from pathlib import Path

PY314 = os.path.expanduser("~/Library/Python/3.14/lib/python/site-packages")
if PY314 not in sys.path:
    sys.path.insert(0, PY314)
try:
    import Cryptodome  # noqa: F401
except ImportError:
    p314 = shutil.which("python3.14")
    if p314 and sys.executable != p314:
        os.execvp(p314, [p314] + sys.argv)

CACHE_PATH = Path.home() / "Library" / "Application Support" / "CodeBurn" / "usage-limits.json"
DEFAULT_OPENCODE_WORKSPACE = "wrk_01KPYTBGPQYB83E2NJPVNYGAYA"
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36")


# ── Chrome cookies ────────────────────────────────────────────────────────

def read_chrome_cookies() -> dict:
    """Return {domain: {name: value}} from Chrome for known providers."""
    try:
        import browser_cookie3
    except ImportError:
        return {}
    result: dict[str, dict[str, str]] = {}
    try:
        cj = browser_cookie3.chrome()
    except Exception:
        return {}

    wants = {
        "claude.ai": ["sessionKey"],
        "cursor.com": ["WorkosCursorSessionToken", "workos-cursor-oauth"],
        "opencode.ai": ["auth"],
        "ollama.com": ["__Secure-session", "session", "ollama_session",
                       "__Secure-next-auth.session-token", "next-auth.session-token",
                       "__Secure-next-auth.session-token.0",
                       "__Secure-next-auth.session-token.1"],
        "krater.ai": ["session", "krater_session", "__Secure-session",
                      "next-auth.session-token", "__Secure-next-auth.session-token"],
    }

    def _match(name: str, candidates: list[str]) -> str | None:
        for c in candidates:
            if name == c or name.startswith(c + "."):
                return c
        return None

    for c in cj:
        domain = c.domain.lstrip(".")
        if domain not in wants:
            continue
        matched = _match(c.name, wants[domain])
        if matched is None:
            continue
        bucket = result.setdefault(domain, {})
        # Concatenate chunked next-auth tokens (.0, .1, ...)
        if c.name == matched and matched not in bucket:
            bucket[matched] = c.value
        elif c.name.startswith(matched + ".") and matched in bucket:
            bucket[matched] += c.value
        elif matched not in bucket:
            bucket[matched] = c.value

    return result


# ── Helpers ───────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_epoch() -> int:
    return int(time.time())


def _http_get(url: str, headers: dict, timeout: int = 15) -> tuple[bytes, dict]:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(), dict(resp.headers)


def _cookie_header(domain: str, cookies: dict, *names: str) -> str | None:
    bucket = cookies.get(domain) if cookies else None
    if not bucket:
        return None
    parts = [f"{n}={bucket[n]}" for n in names if n in bucket]
    return "; ".join(parts) if parts else None


# ── Ollama ────────────────────────────────────────────────────────────────

OLLAMA_LABELS = {
    "session": ["Session usage", "Hourly usage"],
    "weekly": ["Weekly usage"],
}


def fetch_ollama(cookies: dict | None = None) -> dict | None:
    if not cookies:
        cookies = read_chrome_cookies()
    ch = _cookie_header("ollama.com", cookies, "__Secure-session", "session",
                        "ollama_session", "__Secure-next-auth.session-token",
                        "next-auth.session-token")
    if not ch:
        return None

    try:
        body, _ = _http_get(
            "https://ollama.com/settings",
            {
                "Cookie": ch,
                "User-Agent": BROWSER_UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": "https://ollama.com/",
                "Origin": "https://ollama.com",
            },
        )
        html = body.decode("utf-8", errors="replace")
    except Exception:
        return None

    if "Sign in" in html and "Cloud Usage" not in html:
        return None

    def _parse_block(html: str, label: str) -> dict | None:
        idx = html.find(label)
        if idx < 0:
            return None
        tail = html[idx: idx + 1000]
        m_pct = (re.search(r"([0-9]+(?:\.[0-9]+)?)\s*%\s*used", tail) or
                 re.search(r"width:\s*([0-9]+(?:\.[0-9]+)?)%", tail))
        m_date = re.search(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)", tail)
        if not m_pct:
            return None
        return {
            "usedPercent": float(m_pct.group(1)),
            "resetsAt": m_date.group(1) if m_date else None,
        }

    session = None
    for lbl in OLLAMA_LABELS["session"]:
        session = _parse_block(html, lbl)
        if session:
            break
    weekly = _parse_block(html, "Weekly usage") if "Weekly usage" in html else None

    plan_m = re.search(r"Cloud Usage\s*</span>\s*<span[^>]*>([^<]+)</span>", html)
    email_m = re.search(r'id="header-email"[^>]*>([^<]+)<', html)
    plan = plan_m.group(1).strip() if plan_m else None
    email = email_m.group(1).strip() if email_m and "@" in email_m.group(1) else None

    wins = []
    if session:
        wins.append({
            "label": "Session",
            "usedPercent": session["usedPercent"],
            "resetsAt": session["resetsAt"],
            "resetInSec": None,
        })
    if weekly:
        wins.append({
            "label": "Weekly",
            "usedPercent": weekly["usedPercent"],
            "resetsAt": weekly["resetsAt"],
            "resetInSec": None,
        })

    if not wins:
        return None
    return {
        "name": "Ollama",
        "plan": plan or "Cloud",
        "email": email,
        "windows": wins,
    }


# ── OpenCode Go ───────────────────────────────────────────────────────────

def fetch_opencode(cookies: dict | None = None,
                   workspace_id: str = DEFAULT_OPENCODE_WORKSPACE) -> dict | None:
    if not cookies:
        cookies = read_chrome_cookies()
    ch = _cookie_header("opencode.ai", cookies, "auth")
    if not ch:
        return None

    try:
        body, _ = _http_get(
            f"https://opencode.ai/workspace/{workspace_id}/go",
            {
                "Cookie": ch,
                "User-Agent": BROWSER_UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": "https://opencode.ai/",
                "Origin": "https://opencode.ai",
            },
        )
        html = body.decode("utf-8", errors="replace")
    except Exception:
        return None

    patterns = [
        ("Rolling 5h", r"rollingUsage:\$R\[\d+\]=\{status:\"([^\"]+)\",resetInSec:(\d+),usagePercent:([\d.]+)\}"),
        ("Weekly 7d", r"weeklyUsage:\$R\[\d+\]=\{status:\"([^\"]+)\",resetInSec:(\d+),usagePercent:([\d.]+)\}"),
        ("Monthly 30d", r"monthlyUsage:\$R\[\d+\]=\{status:\"([^\"]+)\",resetInSec:(\d+),usagePercent:([\d.]+)\}"),
    ]
    wins = []
    for label, pat in patterns:
        m = re.search(pat, html)
        if m:
            wins.append({
                "label": label,
                "usedPercent": float(m.group(3)),
                "resetsAt": None,
                "resetInSec": int(m.group(2)),
                "status": m.group(1),
            })

    if not wins:
        return None

    upd_m = re.search(r"time\w+Updated:\$R\[\d+\]=new Date\([\"']([^\"']+)[\"']\)", html)
    updated_at = upd_m.group(1) if upd_m else _now_iso()

    return {
        "name": "OpenCode Go",
        "plan": "Go subscription",
        "email": None,
        "workspaceID": workspace_id,
        "updatedAt": updated_at,
        "windows": wins,
    }


# ── Krater.ai ─────────────────────────────────────────────────────────────

def fetch_krater(cookies: dict | None = None) -> dict | None:
    """Best-effort fetch from Krater.ai. The dashboard is a logged-in modal,
    so we read session cookies and look for the dashboard HTML."""
    if not cookies:
        cookies = read_chrome_cookies()
    ch = _cookie_header("krater.ai", cookies, "session", "krater_session",
                        "__Secure-session", "next-auth.session-token",
                        "__Secure-next-auth.session-token")
    if not ch:
        return None

    candidates = [
        "https://krater.ai/dashboard",
        "https://krater.ai/usage",
        "https://www.krater.ai/dashboard",
    ]
    for url in candidates:
        try:
            body, _ = _http_get(
                url,
                {
                    "Cookie": ch,
                    "User-Agent": BROWSER_UA,
                    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
                },
            )
            html = body.decode("utf-8", errors="replace")
        except Exception:
            continue

        m_pct = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*%\s*used", html)
        if not m_pct:
            continue
        wins = [{
            "label": "Usage",
            "usedPercent": float(m_pct.group(1)),
            "resetsAt": None,
            "resetInSec": None,
        }]
        return {
            "name": "Krater",
            "plan": "Pro" if "Pro" in html else "active",
            "email": None,
            "windows": wins,
        }
    return None


# ── Claude ────────────────────────────────────────────────────────────────

_CLAUDE_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": BROWSER_UA,
    "Referer": "https://claude.ai/",
    "Origin": "https://claude.ai",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
}


def fetch_claude(cookies: dict | None = None) -> dict | None:
    sk = cookies.get("claude.ai", {}).get("sessionKey") if cookies else None
    if not sk:
        return None

    h = dict(_CLAUDE_HEADERS)
    h["Cookie"] = f"sessionKey={sk}"

    try:
        body, _ = _http_get("https://claude.ai/api/organizations", h)
        orgs = json.loads(body)
        if not orgs:
            return None
        oid = orgs[0]["uuid"]
        body, _ = _http_get(f"https://claude.ai/api/organizations/{oid}/usage", h)
        usage = json.loads(body)
    except Exception:
        return None

    def _window(d: dict) -> dict | None:
        if not d:
            return None
        return {
            "label": d.get("label", ""),
            "usedPercent": d.get("utilization", 0),
            "resetsAt": d.get("resets_at"),
            "resetInSec": None,
        }

    wins = []
    five = _window(usage.get("five_hour"))
    if five:
        five["label"] = "5-hour"
        wins.append(five)
    seven = _window(usage.get("seven_day"))
    if seven:
        seven["label"] = "7-day"
        wins.append(seven)

    if not wins:
        return None
    return {
        "name": "Claude Code",
        "plan": usage.get("plan", {}).get("title", "Claude Max"),
        "email": None,
        "windows": wins,
    }


# ── Codex ─────────────────────────────────────────────────────────────────

def fetch_codex(_cookies: dict | None = None) -> dict | None:
    ap = os.path.expanduser("~/.codex/auth.json")
    if not os.path.exists(ap):
        return None
    try:
        auth = json.load(open(ap))
        token = auth.get("tokens", {}).get("access_token")
        if not token:
            return None
    except Exception:
        return None

    try:
        body, _ = _http_get(
            "https://chatgpt.com/backend-api/wham/usage",
            {"Authorization": f"Bearer {token}", "User-Agent": BROWSER_UA, "Accept": "application/json"},
        )
        data = json.loads(body)
    except Exception:
        return None

    wins = []
    rl = data.get("rate_limit", {})
    pw, sw = rl.get("primary_window", {}), rl.get("secondary_window", {})
    if pw.get("used_percent") is not None:
        wins.append({
            "label": "5-hour window",
            "usedPercent": pw["used_percent"],
            "resetsAt": None,
            "resetInSec": pw.get("reset_after_seconds"),
        })
    if sw.get("used_percent") is not None:
        wins.append({
            "label": "7-day window",
            "usedPercent": sw["used_percent"],
            "resetsAt": None,
            "resetInSec": sw.get("reset_after_seconds"),
        })
    for arl in data.get("additional_rate_limits", []):
        rl2 = arl.get("rate_limit", {}).get("primary_window", {})
        if rl2.get("used_percent") is not None:
            wins.append({
                "label": arl.get("limit_name", "extra"),
                "usedPercent": rl2["used_percent"],
                "resetsAt": None,
                "resetInSec": rl2.get("reset_after_seconds"),
            })

    if not wins:
        return None
    return {
        "name": "Codex",
        "plan": data.get("plan_type", "unknown"),
        "email": None,
        "windows": wins,
    }


# ── Gemini ────────────────────────────────────────────────────────────────

def _gemini_token() -> str | None:
    try:
        r = subprocess.run(
            ["security", "find-generic-password", "-s", "gemini", "-w"],
            capture_output=True, text=True, timeout=5,
        )
        b64 = r.stdout.strip()
        if b64 and b64.startswith("go-keyring-base64:"):
            data = json.loads(base64.b64decode(b64[len("go-keyring-base64:"):]))
            return data.get("token", {}).get("access_token")
    except Exception:
        pass
    cp = os.path.expanduser("~/.gemini/oauth_creds.json")
    if os.path.exists(cp):
        try:
            creds = json.load(open(cp))
            return creds.get("access_token")
        except Exception:
            pass
    return None


def fetch_gemini(_cookies: dict | None = None) -> dict | None:
    token = _gemini_token()
    if not token:
        return None
    try:
        req = urllib.request.Request(
            "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
            data=b"{}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                     "User-Agent": BROWSER_UA},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except Exception:
        return None

    wins = []
    for b in data.get("buckets", []):
        frac = b.get("remainingFraction")
        if frac is not None:
            wins.append({
                "label": b.get("modelId", "unknown"),
                "usedPercent": round((1 - frac) * 100, 1),
                "resetsAt": b.get("resetTime"),
                "resetInSec": None,
            })
    if not wins:
        return None
    return {"name": "Gemini", "plan": "active", "email": None, "windows": wins}


# ── Cursor ────────────────────────────────────────────────────────────────

def fetch_cursor(cookies: dict | None = None) -> dict | None:
    st = cookies.get("cursor.com", {}).get("WorkosCursorSessionToken") if cookies else None
    if not st:
        return None
    try:
        body, _ = _http_get(
            "https://cursor.com/api/usage-summary",
            {"Cookie": f"WorkosCursorSessionToken={st}", "User-Agent": BROWSER_UA,
             "Accept": "application/json"},
        )
        data = json.loads(body)
    except Exception:
        return None

    wins = []
    pd = data.get("individualUsage", {}).get("plan", {})
    if pd.get("totalPercentUsed") is not None:
        wins.append({
            "label": "Premium requests",
            "usedPercent": pd["totalPercentUsed"],
            "resetsAt": None,
            "resetInSec": None,
        })
    ond = data.get("individualUsage", {}).get("onDemand", {})
    if ond.get("used") is not None and ond.get("limit"):
        wins.append({
            "label": "On-demand (cents)",
            "usedPercent": round(ond["used"] / ond["limit"] * 100, 1),
            "resetsAt": None,
            "resetInSec": None,
        })
    if not wins:
        return None
    return {"name": "Cursor", "plan": data.get("membershipType", "unknown"),
            "email": None, "windows": wins}


# ── Kimi ──────────────────────────────────────────────────────────────────

def fetch_kimi(_cookies: dict | None = None) -> dict | None:
    """Kimi Code (Moonshot). Looks for stored session in ~/.kimi/."""
    import glob
    candidates = glob.glob(os.path.expanduser("~/.kimi/**/*.json"), recursive=True) + \
                 glob.glob(os.path.expanduser("~/.kimi/**/auth*"), recursive=True)
    if not candidates:
        return None
    # Best-effort: pick the first file that looks like it has a token
    token = None
    for path in candidates:
        try:
            d = json.load(open(path))
            token = (d.get("access_token") or d.get("token") or
                     (d.get("tokens") or {}).get("access_token"))
            if token:
                break
        except Exception:
            continue
    if not token:
        return None
    # No public usage endpoint known — return None for now
    return None


# ── Provider registry ─────────────────────────────────────────────────────

PROVIDERS = {
    "claude":   fetch_claude,
    "codex":    fetch_codex,
    "gemini":   fetch_gemini,
    "cursor":   fetch_cursor,
    "opencode": fetch_opencode,
    "ollama":   fetch_ollama,
    "krater":   fetch_krater,
    "kimi":     fetch_kimi,
}


# ── Main ──────────────────────────────────────────────────────────────────

def collect(opts) -> dict:
    cookies = read_chrome_cookies()
    out = {"generatedAt": _now_iso(), "providers": {}}
    for name, fn in PROVIDERS.items():
        if opts.provider and name != opts.provider:
            continue
        try:
            d = fn(cookies)
        except Exception as e:
            d = {"error": str(e)}
        if d is not None:
            out["providers"][name] = d
    return out


def write_cache(data: dict) -> str | None:
    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=2, default=str))
        os.replace(tmp, CACHE_PATH)
        return str(CACHE_PATH)
    except Exception:
        return None


def fmt_bar(pct: float, w: int = 20) -> str:
    pct = min(pct, 100)
    fill = int(pct / 100 * w)
    bar = "█" * fill + "░" * (w - fill)
    c = "\033[91m" if pct >= 90 else "\033[93m" if pct >= 70 else "\033[92m"
    return f"{c}{bar}\033[0m {pct:.0f}%"


def fmt_reset(window: dict) -> str:
    try:
        if window.get("resetsAt"):
            dt = datetime.fromisoformat(window["resetsAt"].replace("Z", "+00:00"))
            diff = dt - datetime.now(timezone.utc)
            if diff.total_seconds() > 0:
                h, r = divmod(int(diff.total_seconds()), 3600)
                m = r // 60
                return f" (in {h}h {m}m)"
        if window.get("resetInSec") is not None:
            h, r = divmod(int(window["resetInSec"]), 3600)
            m = r // 60
            return f" (in {h}h {m}m)"
    except Exception:
        pass
    return ""


def print_human(data: dict) -> None:
    providers = data.get("providers", {})
    if not providers:
        print("No usage data available.")
        return
    for name, d in providers.items():
        plan = d.get("plan", "active")
        print(f"\n===== {d.get('name', name)} — {plan} =====")
        for w in d.get("windows", []):
            print(f"  {w['label']:24} {fmt_bar(w['usedPercent'])}{fmt_reset(w)}")


def run(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Multi-provider usage limits")
    ap.add_argument("provider_pos", nargs="?", help="Provider name (positional)")
    ap.add_argument("-p", "--provider", help="Provider name (legacy flag)")
    ap.add_argument("--json", action="store_true", help="JSON output to stdout")
    ap.add_argument("--write-cache", action="store_true",
                    help="Write JSON cache file for Swift to read")
    ap.add_argument("--workspace", default=DEFAULT_OPENCODE_WORKSPACE,
                    help=f"OpenCode workspace ID (default: {DEFAULT_OPENCODE_WORKSPACE})")
    opts = ap.parse_args(argv)

    provider = opts.provider_pos or opts.provider
    if provider:
        opts.provider = provider

    # Special-case: opencode workspace can be customized
    if opts.provider == "opencode" and opts.workspace:
        original = PROVIDERS["opencode"]
        PROVIDERS["opencode"] = lambda c: original(c, workspace_id=opts.workspace)

    data = collect(opts)

    if opts.json:
        out = json.dumps(data, indent=2, default=str)
        print(out)
    else:
        print_human(data)

    if opts.write_cache:
        path = write_cache(data)
        if path and not opts.json:
            print(f"\n[cache] {path}")

    return 0


if __name__ == "__main__":
    sys.exit(run())
