#!/usr/bin/env python3
"""Extract localizable keys from the Swift sources.

Finds SwiftUI LocalizedStringKey literal sites, L("...") calls and LR("...")
literal calls. Interpolated literals are converted to the format keys SwiftUI /
String.LocalizationValue generate at runtime using a small type heuristic; those
are flagged with '?' so a human can double-check the specifier.

Usage: extract_keys.py [--json] [SOURCES_DIR]
"""
import os, re, sys, json

ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "Sources", "CodeBurnMenubar")
args = [a for a in sys.argv[1:] if not a.startswith("--")]
if args:
    ROOT = args[0]
AS_JSON = "--json" in sys.argv

VIEW_CALLS = r"(?:Text|Button|Toggle|Label|Picker|Section|TextField|SecureField|Link|Menu|NavigationLink|Stepper|DatePicker|ProgressView|ContentUnavailableView|LabeledContent|GroupBox|DisclosureGroup|Tab|LocalizedStringKey|L|LR)"
MODIFIERS = r"\.(?:help|navigationTitle|accessibilityLabel|accessibilityHint|accessibilityValue|alert|confirmationDialog|badge|tabItem|contextMenu)"
# A Swift string literal that may contain \( ... ) interpolations with nested parens/quotes.
LIT = r'"((?:[^"\\]|\\.|\\\((?:[^()"]|"(?:[^"\\]|\\.)*"|\([^()]*\))*\))*)"'
CALL_RE = re.compile(r"(?<![A-Za-z0-9_.])" + VIEW_CALLS + r"\(\s*" + LIT)
MOD_RE = re.compile(MODIFIERS + r"\(\s*" + LIT)
INTERP_RE = re.compile(r"\\\(((?:[^()\"]|\"(?:[^\"\\]|\\.)*\"|\([^()]*\))*)\)")

INT_HINTS = re.compile(r"\b(count|calls|sessions|turns|days|index|Int\(|\.count|number|total|attempt|remaining|hours|minutes|seconds|percent|pct)\b", re.I)
DOUBLE_HINTS = re.compile(r"\b(Double\(|CGFloat\(|cost|usd|rate|ratio|scale|amount|price)\b", re.I)

def specifier(expr: str) -> str:
    e = expr.strip()
    if re.search(r"\bInt(64)?\(", e) or re.search(r"\.count\b", e):
        return "%lld"
    if re.search(r"\b(Double|CGFloat|Float)\(", e):
        return "%lf"
    if re.search(r"String\(|\"|\.formatted\(|\.uppercased\(|\.lowercased\(|\.capitalized|\.rawValue|\.displayName|\.label|\.name|\.title|\.symbol|\.code", e):
        return "%@"
    if INT_HINTS.search(e):
        return "%lld"
    if DOUBLE_HINTS.search(e):
        return "%lf"
    return "%@"

def to_key(lit: str):
    interp = False
    def sub(m):
        nonlocal interp
        interp = True
        return specifier(m.group(1))
    key = INTERP_RE.sub(sub, lit)
    return key, interp

keys = {}
for dirpath, _, files in os.walk(ROOT):
    for fn in files:
        if not fn.endswith(".swift"):
            continue
        path = os.path.join(dirpath, fn)
        rel = os.path.relpath(path, ROOT)
        src = open(path, encoding="utf-8").read()
        for m in list(CALL_RE.finditer(src)) + list(MOD_RE.finditer(src)):
            lit = m.group(1)
            if lit.startswith("\\(") and lit.endswith(")") and lit.count("\\(") == 1:
                continue  # pure interpolation: Text("\(value)") is not a translatable key
            key, interp = to_key(lit)
            if not re.search(r"[A-Za-z]", key):
                continue
            entry = keys.setdefault(key, {"files": set(), "interp": False})
            entry["files"].add(rel)
            entry["interp"] = entry["interp"] or interp

if AS_JSON:
    print(json.dumps({k: {"files": sorted(v["files"]), "interp": v["interp"]} for k, v in sorted(keys.items())}, ensure_ascii=False, indent=1))
else:
    for k in sorted(keys):
        flag = "?" if keys[k]["interp"] else " "
        print(f"{flag} {k}")
    print(f"# {len(keys)} keys", file=sys.stderr)
