// PROTOTYPE CONTRACT OUTLINE — not runnable production code.
import { run } from "@ai-hero/sandcastle";

// Host-owned responsibilities:
// 1. Read current GitHub Issue frontier and Integration Branch HEAD.
// 2. Reject stale expected_head before any write.
// 3. Select one ticket or one final-stage unit.
// 4. Run configured bootstrap/test/verification argv commands.
// 5. Publish commits, Issue updates, markers, and the next workflow dispatch.
//
// Sandcastle-owned responsibilities:
// - Agent execution, sandbox, worktree, and provider runtime.
//
// Security boundary:
// - GITHUB_TOKEN remains in the host orchestrator.
// - Only ANTHROPIC_AUTH_TOKEN reaches the Sandcastle execution path.

export async function processOneTicket(prompt: string): Promise<void> {
  await run({ prompt });
}
