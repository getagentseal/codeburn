---
name: cost
description: Show what AI coding tools cost today, from CodeBurn. Use when the user asks about today's AI spend or token use, or which model or project cost the most.
allowed-tools: Bash(npx -y codeburn@0.9.28 today)
---

Today's AI coding usage, from CodeBurn. It reads the session logs that Claude Code, Codex, Cursor and other tools keep on this machine:

!`npx -y codeburn@0.9.28 today`

Summarize this in at most five short bullets: the total cost, the models and projects that cost the most, anything unusual, and one concrete way to spend less. Use only the numbers above.
