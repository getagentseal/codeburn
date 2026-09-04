#!/usr/bin/env python3
"""Merge translation fragments into Resources/zh-Hans.lproj/Localizable.strings
and report keys found in the sources that have no translation.

Usage: merge_strings.py FRAGMENT_DIR [--write]
"""
import os, re, sys, subprocess, json

here = os.path.dirname(os.path.abspath(__file__))
frag_dir = sys.argv[1]
write = "--write" in sys.argv
res = os.path.join(here, "..", "..", "Sources", "CodeBurnMenubar", "Resources")
zh_path = os.path.join(res, "zh-Hans.lproj", "Localizable.strings")
en_path = os.path.join(res, "en.lproj", "Localizable.strings")

ENTRY = re.compile(r'^\s*"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;\s*(?://.*)?$')

def parse(path):
    out = {}
    for ln, line in enumerate(open(path, encoding="utf-8"), 1):
        s = line.strip()
        if not s or s.startswith("//") or s.startswith("/*") or s.startswith("*"):
            continue
        m = ENTRY.match(line)
        if not m:
            print(f"  skip {os.path.basename(path)}:{ln}: {s[:80]}", file=sys.stderr)
            continue
        out[m.group(1)] = m.group(2)
    return out

merged = {}
sources = {}
for fn in sorted(os.listdir(frag_dir)):
    if not fn.endswith(".strings"):
        continue
    for k, v in parse(os.path.join(frag_dir, fn)).items():
        if k in merged and merged[k] != v:
            print(f"  conflict {k!r}: keeping {merged[k]!r} from {sources[k]}, ignoring {v!r} from {fn}", file=sys.stderr)
            continue
        merged[k] = v
        sources[k] = fn
if os.path.exists(zh_path):
    for k, v in parse(zh_path).items():
        merged.setdefault(k, v)

extracted = json.loads(subprocess.check_output([sys.executable, os.path.join(here, "extract_keys.py"), "--json"]).decode())
missing = [k for k in extracted if k not in merged]
identical = [k for k, v in merged.items() if k == v]
print(f"fragments: {len(merged)} translations; sources: {len(extracted)} keys; missing: {len(missing)}; untranslated(identity): {len(identical)}")
for k in missing:
    print(f"  MISSING {'?' if extracted[k]['interp'] else ' '} {k}   <- {', '.join(extracted[k]['files'])}")

if write:
    os.makedirs(os.path.dirname(zh_path), exist_ok=True)
    os.makedirs(os.path.dirname(en_path), exist_ok=True)
    with open(zh_path, "w", encoding="utf-8") as f:
        f.write("/* CodeBurn Menubar — Simplified Chinese. Keys are the English source strings. */\n")
        for k in sorted(merged):
            f.write(f'"{k}" = "{merged[k]}";\n')
    with open(en_path, "w", encoding="utf-8") as f:
        f.write("/* CodeBurn Menubar — English (development language). Keys equal values; present so macOS offers English as a localization. */\n")
        for k in sorted(set(merged) | set(extracted)):
            f.write(f'"{k}" = "{k}";\n')
    print(f"wrote {zh_path} and {en_path}")
