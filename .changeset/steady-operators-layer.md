---
'@agents-ensemble/core': patch
'@agents-ensemble/cli': patch
---

ADR 0031 で operator-agent 層を採用し、Phase 1 は conductor の config・backend・認証を流用して `ConductorAgent`（SDK / Pi、ACP 非採用）で動かす方針を architecture / modular-prompt に追記しました。
