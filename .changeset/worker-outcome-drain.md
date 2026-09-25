---
"@agents-ensemble/core": patch
---

Ensure dispatchable worker completion and failure events are delivered before a conductor session stops, regardless of which event source triggered the preceding send.
