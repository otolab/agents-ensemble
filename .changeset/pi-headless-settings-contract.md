---
'@agents-ensemble/core': patch
---

Pi conductor の headless 設定をコード上の allowlist に基づいて適用し、`.ensemble/pi` と Pi SDK の project settings の境界を明確化します。`compaction` / `branchSummary` の再適用ポリシーも create / reload / resume のライフサイクルに合わせて統一します。
