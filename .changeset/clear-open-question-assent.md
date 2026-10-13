---
'@agents-ensemble/core': patch
'@agents-ensemble/cli': patch
---

Record open-question `yes_no` answers as three-way assent and add choice questions with a canonical selected option id. Existing sidecars remain readable, and legacy `approved` values are restored unchanged rather than recalculated; new `approved` values are derived only for permission-linked `yes_no` questions.
