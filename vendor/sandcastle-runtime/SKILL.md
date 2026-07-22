---
name: sandcastle-runtime
description: Sandcastle host protocol wrapper for executing one enrolled Ticket with pinned engineering skills. Use only when the Sandcastle orchestrator provides Batch, Ticket, Session, protected-path, and publication boundaries.
---

# Sandcastle Runtime

This wrapper delegates to the upstream `implement`, `tdd`, and `code-review` skills without modifying their snapshots.

1. Treat the host-provided Ticket snapshot and protected paths as authoritative.
2. Enter through `implement`; invoke `tdd` before the first implementation change at the pre-confirmed seam.
3. Run focused checks and typechecking during implementation, then the complete configured tests and verification commands.
4. Invoke `code-review` only after full verification succeeds.
5. Return the real skill outcomes and final worktree diff to the host. Do not commit, push, close issues, update PRs, or write audit records from the sandbox.

Fail closed when the Ticket spec, testing seam, required skill, protected-path policy, or fixed review point is missing.

Write phase evidence to the host-provided `--output` path as JSON. Implementation evidence uses `schemaVersion: 1`, `phase: "implementation"`, `status: "implemented"`, the contract `ticket` and `sessionId`, the exact resulting `head`, and ordered `events`. Record successful `implement` and `tdd` calls as `skill-tool-result` events with their real `toolCallId`; record the first repository edit as `workspace-change`. Review evidence uses `schemaVersion: 1`, `phase: "review"`, the contract `ticket`, `sessionId`, `review.fixedPoint`, `review.head`, and `review.verificationHash`, plus machine-readable `findings` on the `Standards` or `Spec` axis and a successful `code-review` tool event with its real `toolCallId`.

If implementation determines that the Ticket already requires no repository change, return `status: "no-change"` at the unchanged contract HEAD with successful `implement` and `tdd` events and no `workspace-change` event. Do not invoke `code-review`; the host will wait for an explicit human no-change decision.
