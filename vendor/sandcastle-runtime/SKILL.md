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
