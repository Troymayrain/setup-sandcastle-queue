import assert from "node:assert/strict";
import test from "node:test";

import {
  activateAndSelectFrontier,
  validateTicketContract,
} from "../dist/frontier.js";

const contract = `## What to build

Implement one observable result.

## Acceptance criteria

- [ ] The result is externally verified.

## Blocked by

- None.
`;

function issue(number, overrides = {}) {
  return {
    assignees: [],
    body: contract,
    issue_dependencies_summary: { blocked_by: 0 },
    labels: [{ name: "READY-FOR-AGENT" }],
    number,
    state: "open",
    ...overrides,
  };
}

function fakeClient(initial) {
  const issues = new Map(initial.map((value) => [value.number, structuredClone(value)]));
  const calls = [];
  return {
    calls,
    issues,
    async addLabel(number, label) {
      calls.push(["addLabel", number, label]);
      issues.get(number).labels.push({ name: label });
    },
    async getIssue(number) {
      calls.push(["getIssue", number]);
      return structuredClone(issues.get(number));
    },
    async listOpenIssues(page) {
      calls.push(["listOpenIssues", page]);
      return [...issues.values()]
        .filter(({ state }) => state === "open")
        .sort((left, right) => left.number - right.number)
        .slice((page - 1) * 100, page * 100)
        .map((value) => structuredClone(value));
    },
  };
}

test("Ticket Contract requires unique non-empty sections and an unchecked acceptance", () => {
  assert.equal(validateTicketContract(contract), true);
  assert.equal(validateTicketContract(contract.replace("- [ ]", "- [x]")), false);
  assert.equal(validateTicketContract(contract.replace("Implement one observable result.", "")), false);
  assert.equal(validateTicketContract(`${contract}\n## What to build\nagain\n`), false);
});

test("manual activation paginates, verifies visibility, and selects the smallest executable issue", async () => {
  const fillers = Array.from({ length: 100 }, (_, index) =>
    issue(index + 1000, { assignees: [{ login: "human" }] }),
  );
  const client = fakeClient([
    ...fillers,
    issue(9, { issue_dependencies_summary: { blocked_by: 1 } }),
    issue(7),
    issue(5),
  ]);

  const result = await activateAndSelectFrontier(
    client,
    { ownership: "sandcastle", ready: "ready-for-agent" },
    true,
  );

  assert.equal(result.status, "ready");
  assert.equal(result.ticket, 5);
  assert.deepEqual(result.activated, [5, 7, 9]);
  assert.ok(client.calls.some(([name, page]) => name === "listOpenIssues" && page === 2));
  for (const number of result.activated) {
    assert.ok(
      client.calls.filter(([name, candidate]) => name === "getIssue" && candidate === number)
        .length >= 3,
    );
  }
});

test("assigned or native-blocked owned Tickets wait and contradictory facts fail closed", async () => {
  const waiting = fakeClient([
    issue(1, {
      assignees: [{ login: "human" }],
      labels: [{ name: "sandcastle" }, { name: "ready-for-agent" }],
    }),
    issue(2, {
      issue_dependencies_summary: { blocked_by: 1 },
      labels: [{ name: "sandcastle" }, { name: "ready-for-agent" }],
    }),
  ]);
  assert.deepEqual(
    await activateAndSelectFrontier(
      waiting,
      { ownership: "sandcastle", ready: "ready-for-agent" },
      false,
    ),
    { activated: [], reason: "blocked", status: "waiting" },
  );

  const conflict = fakeClient([
    issue(3, {
      issue_dependencies_summary: undefined,
      labels: [{ name: "sandcastle" }, { name: "ready-for-agent" }],
    }),
  ]);
  assert.equal(
    (
      await activateAndSelectFrontier(
        conflict,
        { ownership: "sandcastle", ready: "ready-for-agent" },
        false,
      )
    ).status,
    "conflict",
  );
});

test("an empty manual activation waits without any branch or pull-request boundary", async () => {
  const client = fakeClient([]);
  const result = await activateAndSelectFrontier(
    client,
    { ownership: "sandcastle", ready: "ready-for-agent" },
    true,
  );
  assert.deepEqual(result, { activated: [], reason: "empty", status: "waiting" });
  assert.equal(
    client.calls.some(([name]) => /branch|pull/iu.test(name)),
    false,
  );
});

test("fresh reads catch concurrent ownership and missing activation facts fail closed", async () => {
  const current = issue(4, {
    labels: [{ name: "ready-for-agent" }, { name: "sandcastle" }],
  });
  const concurrent = {
    addLabel: async () => {},
    getIssue: async () => structuredClone(current),
    listOpenIssues: async (page) =>
      page === 1
        ? [
            {
              ...structuredClone(current),
              labels: [{ name: "ready-for-agent" }],
            },
          ]
        : [],
  };
  assert.equal(
    (
      await activateAndSelectFrontier(
        concurrent,
        { ownership: "sandcastle", ready: "ready-for-agent" },
        false,
      )
    ).status,
    "ready",
  );

  const missingFacts = fakeClient([
    issue(5, { issue_dependencies_summary: undefined }),
  ]);
  assert.equal(
    (
      await activateAndSelectFrontier(
        missingFacts,
        { ownership: "sandcastle", ready: "ready-for-agent" },
        true,
      )
    ).status,
    "conflict",
  );
});
