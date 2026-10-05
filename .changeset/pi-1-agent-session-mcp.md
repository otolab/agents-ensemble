---
'@agents-ensemble/core': minor
---

Migrate the Pi conductor backend to the Pi 1.x AgentSession SDK and its official MCP extension. This is a breaking change for Pi conductor MCP configuration: SSE servers are no longer supported, MCP tools use Pi's `mcp__<server>__<tool>` names, and HTTP OAuth/resource tools are handled by the official extension.
