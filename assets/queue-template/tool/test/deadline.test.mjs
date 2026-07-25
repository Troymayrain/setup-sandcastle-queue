import assert from "node:assert/strict";
import test from "node:test";

import {
  ProcessingDeadlineError,
  runWithTicketDeadline,
} from "../dist/deadline.js";

const beforeHead = "1".repeat(40);
const afterHead = "2".repeat(40);

function scheduler(now = 1_000) {
  let callback;
  const delays = [];
  let cleared = false;
  return {
    api: {
      clearTimeout() {
        cleared = true;
      },
      now: () => now,
      setTimeout(value, delay) {
        callback = value;
        delays.push(delay);
        return 1;
      },
    },
    get cleared() {
      return cleared;
    },
    delays,
    fire() {
      callback();
    },
  };
}

function pendingExecution(state) {
  return async ({ onBeforeHead, signal }) => {
    onBeforeHead(beforeHead);
    state.ready();
    await new Promise((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("Sandcastle cancelled")),
        { once: true },
      );
    });
  };
}

async function deadlineCase(publication) {
  const timer = scheduler();
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const run = runWithTicketDeadline(
    {
      hardDeadlineAtMs: 100_000,
      reserveMinutes: 1,
      ticket: 58,
    },
    pendingExecution({ ready: release }),
    publication,
    timer.api,
  );
  await ready;
  timer.fire();
  return { run, timer };
}

test("Ticket deadline is exactly hard deadline minus Host finalization reserve", async () => {
  const timer = scheduler(10_000);
  const result = await runWithTicketDeadline(
    {
      hardDeadlineAtMs: 130_000,
      reserveMinutes: 1,
      ticket: 58,
    },
    async ({ onBeforeHead, onExecutionComplete }) => {
      onBeforeHead(beforeHead);
      onExecutionComplete();
      return { completionCommit: afterHead, status: "published", ticket: 58 };
    },
    async () => {
      throw new Error("must not inspect publication after completion");
    },
    timer.api,
  );

  assert.deepEqual(timer.delays, [60_000]);
  assert.equal(timer.cleared, true);
  assert.equal(result.status, "published");
});

test("deadline accepts only complete publication for the current Ticket", async () => {
  const { run } = await deadlineCase(async (input) => {
    assert.deepEqual(input, { beforeHead, ticket: 58 });
    return { head: afterHead, status: "complete", ticket: 58 };
  });

  assert.deepEqual(await run, {
    completionCommit: afterHead,
    status: "published",
    ticket: 58,
  });
});

test("confirmed absence and unknown publication fail with distinct statuses", async () => {
  const absent = await deadlineCase(async () => ({ status: "absent" }));
  await assert.rejects(absent.run, (error) => {
    assert.ok(error instanceof ProcessingDeadlineError);
    assert.equal(error.status, "ticket-deadline-exceeded");
    return true;
  });

  for (const fact of [
    { status: "unknown" },
    { head: afterHead, status: "complete", ticket: 57 },
  ]) {
    const unknown = await deadlineCase(async () => fact);
    await assert.rejects(unknown.run, (error) => {
      assert.ok(error instanceof ProcessingDeadlineError);
      assert.equal(error.status, "publication-unknown");
      return true;
    });
  }
});
