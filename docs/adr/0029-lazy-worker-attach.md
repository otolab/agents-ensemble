# ADR 0029: Lazy worker ACP attach

- Status: accepted
- Date: 2026-10-16
- Related: [ADR 0011](0011-session-sidecar-resume.md), [ADR 0012](0012-conductor-worker-prompt-roundtrip.md), [Issue #433](https://github.com/otolab/agents-ensemble/issues/433)

## Context

Every profile worker was attached and initialized at session startup, even when the conductor never needed it. This starts ACP processes and can incur authentication and init prompt costs before the first worker instruction.

The profile must still define the complete worker roster before the conductor starts. Existing users also rely on eager startup, and the current init prompt and instruction event model distinguishes `source: harness` from `source: conductor`.

## Decision

- Add `session.lazyWorkers` to ensemble config. It defaults to `false`; omitted and legacy configuration keeps eager startup. The resolved choice is stored in the session sidecar.
- Register every profile worker and expose its name and kind at session start. In lazy mode its lifecycle state is `sleeping`; `list_workers` and `get_worker_status` include it. The TUI displays `sleep`, distinct from attached `idle`.
- A normal first `prompt_worker` to a sleeping worker starts its ACP attach and init prompt. There is no wake-specific tool or prompt. After init completes, the first instruction is sent as a separate `source: conductor` prompt round. This preserves event symmetry, `worker.round` accounting, and the distinction between init and work.
- Keep the worker resident through session end after its first attach. Idle timeout shutdown and re-sleep are out of scope.
- Preserve event semantics: `harness.session.workers` seeds the roster with its initial state; eager startup emits the existing grouped `harness.worker.bootstrap` event; lazy startup emits it for the individual worker immediately before attach. Prompt lifecycle events retain their existing source values.
- During the attach handshake, queue additional instructions. A `preempt: true` instruction replaces queued instructions but does not interrupt the handshake or init prompt because no resident ACP prompt is available to cancel yet. Once resident, existing preempt and queue behavior applies.
- Keep init permission requests on the normal permission event path. The original first instruction remains queued until init finishes and any permission decision is resolved.
- On attach failure, discard queued instructions, report `worker.failed`, keep the worker in `failed`, and return the failure on later instructions. Do not retry automatically. Unknown names remain rejected by the tool schema and runtime registry.
- On resume, use the sidecar policy. Reattach workers with saved ACP session IDs and leave other lazy workers sleeping. A sidecar without `lazyWorkers` predates the setting and resumes eagerly.
- Team profiles describe workers as registered from session start; ACP attachment may be eager or happen on first instruction. No profile assumes that lazy workers already have ACP sessions.

## Consequences

- Sessions that do not dispatch a worker avoid its ACP process, authentication, and init prompt costs while preserving the fixed profile roster.
- The first dispatch to a sleeping worker takes longer because it includes attach and init before the requested instruction.
- The conductor may receive init completion or permission events while the first instruction is still queued; it must handle them through the existing event loop.
- `list_workers` state vocabulary gains `sleeping`, and TUI state vocabulary gains `sleep`.
- ACP process and authentication failures for lazy workers occur on first use rather than at session startup.
