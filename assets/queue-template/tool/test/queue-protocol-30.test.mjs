import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderFinalReviewMarker } from "../dist/final-review-facts.js";
import {
  completionMessage,
  renderPublicationMarker,
} from "../dist/publication-facts.js";
import { executeWorkflowHostOperation } from "../dist/workflow-host.js";

const baseHead = "b".repeat(40);
const integrationBranch = "sandcastle/integration";
const labels = {
  ownership: "sandcastle",
  ready: "ready-for-agent",
};
const ticketContract = `## What to build

Implement one observable result.

## Acceptance criteria

- [ ] The result is externally verified.

## Blocked by

- Native GitHub dependencies only.
`;

function objectId(kind, value) {
  return createHash("sha1").update(`${kind}:${value}`).digest("hex");
}

function ticket(number, overrides = {}) {
  return {
    assignees: [],
    body: ticketContract,
    issue_dependencies_summary: { blocked_by: 0 },
    labels: [
      {
        name: number % 2 === 0 ? "READY-FOR-AGENT" : "ready-for-agent",
      },
    ],
    number,
    state: "open",
    ...overrides,
  };
}

class StatefulQueueFake {
  constructor() {
    this.baseHead = baseHead;
    this.comments = new Map();
    this.commits = new Map([
      [
        baseHead,
        {
          message: "Base commit",
          parents: [],
          sha: baseHead,
        },
      ],
    ]);
    this.completionCommits = [];
    this.crashInjected = false;
    this.crashTicket = 215;
    this.currentRunId = "";
    this.currentTicket = null;
    this.events = [];
    this.integrationHead = null;
    this.issues = new Map();
    this.localHeadValue = null;
    this.pullRequest = null;
    this.repository = mkdtempSync(join(tmpdir(), "queue-protocol-repository-"));
    this.sessionInputs = [];
    this.sessionIds = [];
    this.finalFixPrompt = join(this.repository, "final-fix.md");
    this.finalReviewPrompt = join(this.repository, "final-review.md");
    this.ticketPrompt = join(this.repository, "ticket.md");
    writeFileSync(this.finalFixPrompt, "# Final Fix\n\nFix the reviewed result.\n");
    writeFileSync(
      this.finalReviewPrompt,
      "# Final Review\n\nReturn pass or needs-fix.\n",
    );
    writeFileSync(this.ticketPrompt, "# Ticket\n\nImplement the selected Ticket.\n");

    for (let number = 201; number <= 230; number += 1) {
      this.issues.set(number, ticket(number));
    }
    this.dependencies = new Map([[202, [205]]]);
    for (let number = 1000; number < 1075; number += 1) {
      this.issues.set(
        number,
        ticket(number, {
          labels: [{ name: "documentation" }],
        }),
      );
    }
    this.issues.set(
      150,
      ticket(150, {
        assignees: [{ login: "human" }],
      }),
    );
    this.issues.set(
      151,
      ticket(151, {
        body: "## What to build\n\nMissing required sections.\n",
      }),
    );
  }

  cloneIssue(value) {
    const blockers = this.dependencies.get(value.number) ?? [];
    return structuredClone({
      ...value,
      issue_dependencies_summary: {
        blocked_by: blockers.filter(
          (number) => this.issues.get(number)?.state === "open",
        ).length,
      },
    });
  }

  async addLabel(number, label) {
    this.events.push(["addLabel", number, label]);
    this.issues.get(number).labels.push({ name: label });
  }

  async annotateCompletionCommit(metadata) {
    const issue = metadata.issue;
    const completionCommit = objectId("completion", issue);
    this.events.push(["annotate", issue, metadata, completionCommit]);
    this.commits.set(completionCommit, {
      message: completionMessage(`Implement Ticket #${issue}`, metadata),
      parents: [metadata.beforeHead],
      sha: completionCommit,
    });
    this.completionCommits.push(completionCommit);
    this.localHeadValue = completionCommit;
    return completionCommit;
  }

  async checkoutIntegration(branch, head) {
    this.events.push(["checkout", this.currentRunId, branch, head]);
    this.localHeadValue = head;
  }

  async closeIssue(issue) {
    this.events.push(["close", issue, this.integrationHead]);
    this.issues.get(issue).state = "closed";
  }

  async commitParents(commit) {
    return this.commits.get(commit)?.parents ?? [];
  }

  async createDraftPullRequest(input) {
    this.events.push(["createDraftPr", input]);
    assert.equal(this.pullRequest, null);
    this.pullRequest = {
      draft: true,
      nodeId: "PR_node_1",
      number: 900,
      state: "open",
      url: "https://example.invalid/pr/900",
    };
    return structuredClone(this.pullRequest);
  }

  async createFinalReviewMarker(pullRequest, marker) {
    this.events.push(["finalReviewMarker", pullRequest, marker]);
    const comments = this.comments.get(pullRequest) ?? [];
    const value = {
      body: renderFinalReviewMarker(marker),
      id: 9000 + comments.length,
    };
    comments.push(value);
    this.comments.set(pullRequest, comments);
    return { id: value.id };
  }

  async createIntegrationBranch(branch, head) {
    this.events.push(["createBranch", branch, head]);
    assert.equal(this.integrationHead, null);
    this.integrationHead = head;
  }

  async createPublicationMarker(issue, marker) {
    this.events.push(["markerAttempt", issue, marker.afterHead]);
    if (issue === this.crashTicket && !this.crashInjected) {
      this.crashInjected = true;
      throw new Error("injected crash after push verification");
    }
    const comments = this.comments.get(issue) ?? [];
    const value = {
      body: renderPublicationMarker(marker),
      id: issue * 100 + comments.length,
    };
    comments.push(value);
    this.comments.set(issue, comments);
    this.events.push(["marker", issue, marker.afterHead]);
    return { id: value.id };
  }

  async createTemporaryMerge(input) {
    this.events.push(["temporaryMerge", input]);
    const path = mkdtempSync(join(tmpdir(), "queue-protocol-final-review-"));
    return {
      baseHead: this.baseHead,
      integrationHead: this.integrationHead,
      path,
      remove: async () => {
        this.events.push(["removeTemporaryMerge"]);
      },
      unchanged: async () => true,
    };
  }

  async dispatchContinuation(payload) {
    this.events.push(["dispatch", "continue", payload]);
    this.dispatched = {
      expectedHead: payload.inputs.expected_head,
      operation: "continue",
      predecessorRunId: payload.inputs.predecessor_run_id,
    };
  }

  async dispatchFinalFix(payload) {
    this.events.push(["dispatch", "final-fix", payload]);
    throw new Error("passing Final Review must not dispatch Final Fix");
  }

  async dispatchFinalReview(payload) {
    this.events.push(["dispatch", "final-review", payload]);
    this.dispatched = {
      expectedHead: payload.inputs.expected_head,
      operation: "final-review",
      predecessorRunId: payload.inputs.predecessor_run_id,
    };
  }

  async dispatchFinalRereview(payload) {
    this.events.push(["dispatch", "final-rereview", payload]);
    throw new Error("first Final Review must not dispatch Final Rereview");
  }

  async getCommit(sha) {
    this.events.push(["getCommit", sha]);
    return structuredClone(this.commits.get(sha));
  }

  async getIssue(number) {
    this.events.push(["getIssue", number]);
    return this.cloneIssue(this.issues.get(number));
  }

  async isClean() {
    return true;
  }

  async listIntegrationPullRequests(input) {
    this.events.push(["listPr", input]);
    return this.pullRequest ? [structuredClone(this.pullRequest)] : [];
  }

  async listIssueComments(issue) {
    this.events.push(["comments", issue]);
    return structuredClone(this.comments.get(issue) ?? []);
  }

  async listOpenIssues(page) {
    this.events.push(["listOpenIssues", page]);
    return [...this.issues.values()]
      .filter(({ state }) => state === "open")
      .sort((left, right) => left.number - right.number)
      .slice((page - 1) * 100, page * 100)
      .map((value) => this.cloneIssue(value));
  }

  async localHead() {
    return this.localHeadValue;
  }

  async markPullRequestReady(nodeId) {
    this.events.push(["readyForHumanReview", nodeId]);
    this.pullRequest.draft = false;
  }

  async pushIntegration(branch, before, after) {
    this.events.push(["push", this.currentTicket, branch, before, after]);
    assert.equal(this.integrationHead ?? this.baseHead, before);
    this.integrationHead = after;
  }

  async remoteHead(branch) {
    const head = branch === "main" ? this.baseHead : this.integrationHead;
    this.events.push(["remoteHead", branch, head]);
    return head;
  }

  async runCommand(pathOrArgv, argvOrEnvironment, maybeEnvironment) {
    const finalReview = typeof pathOrArgv === "string";
    const argv = finalReview ? argvOrEnvironment : pathOrArgv;
    const environment = finalReview ? maybeEnvironment : argvOrEnvironment;
    this.events.push([
      "command",
      finalReview ? "final-review" : this.currentTicket,
      argv,
      environment,
    ]);
  }

  ticketWorkUnit = async (input) => {
    const selected = readFileSync(input.promptFile, "utf8").match(
      /## Selected GitHub Ticket #([1-9][0-9]*)/u,
    );
    assert.ok(selected, "workflow-host must bind the selected Ticket prompt");
    const issue = Number(selected[1]);
    this.currentTicket = issue;
    const agentCommit = objectId("agent", issue);
    const beforeHead = this.integrationHead ?? this.baseHead;
    this.events.push(["sandcastle", "ticket", this.currentRunId, issue]);
    this.commits.set(agentCommit, {
      message: `Agent commit for #${issue}`,
      parents: [beforeHead],
      sha: agentCommit,
    });
    this.localHeadValue = agentCommit;
    this.sessionInputs.push(input);
    this.sessionIds.push(`ticket-session-${issue}`);
    return {
      branch: integrationBranch,
      commits: [agentCommit],
      role: "ticket",
      sessionId: `ticket-session-${issue}`,
      status: "complete",
      streamSummary: { jsonLines: 1, lineCount: 1, textLines: 0 },
    };
  };

  finalReviewWorkUnit = async (input) => {
    this.events.push(["sandcastle", "final-review", this.currentRunId]);
    this.sessionInputs.push(input);
    return {
      branch: integrationBranch,
      commits: [],
      role: "final-review",
      sessionId: "final-review-session-1",
      status: "complete",
      streamSummary: { jsonLines: 1, lineCount: 1, textLines: 0 },
      verdict: "pass",
    };
  };

  runWorkUnit = (input) =>
    input.role === "ticket"
      ? this.ticketWorkUnit(input)
      : this.finalReviewWorkUnit(input);
}

function workflowConfig() {
  return {
    commands: {
      bootstrap: [{ argv: ["fixture", "bootstrap"] }],
      test: [{ argv: ["fixture", "test"] }],
      verification: [{ argv: ["fixture", "verification"] }],
    },
    execution: {
      hostFinalizationReserveMinutes: 15,
    },
    models: {
      finalFix: "fake-final-fix-model",
      finalReview: "fake-final-review-model",
      ticket: "fake-ticket-model",
    },
    queue: {
      ownershipLabel: labels.ownership,
      readyLabel: labels.ready,
    },
    repository: {
      baseBranch: "main",
      integrationBranch,
    },
  };
}

function executeInvocation(state, invocation) {
  state.currentRunId = invocation.runId;
  return executeWorkflowHostOperation(
    {
      config: workflowConfig(),
      environment: {
        GITHUB_RUN_ID: invocation.runId,
        GITHUB_TOKEN: "host-only-token",
        SANDCASTLE_JOB_HARD_DEADLINE_MS: String(
          Date.now() + 60 * 60_000,
        ),
      },
      expectedHead: invocation.expectedHead,
      operation: invocation.operation,
      predecessorRunId: invocation.predecessorRunId,
      promptFiles: {
        finalFix: state.finalFixPrompt,
        finalReview: state.finalReviewPrompt,
        ticket: state.ticketPrompt,
      },
      repository: state.repository,
    },
    {
      finalReviewHost: state,
      github: state,
      integrationHost: state,
      runWorkUnit: state.runWorkUnit,
    },
  );
}

function nextInvocation(state, runId) {
  const dispatched = state.dispatched;
  state.dispatched = null;
  return {
    baseBranch: "main",
    expectedHead: dispatched.expectedHead,
    integrationBranch,
    operation: dispatched.operation,
    predecessorRunId: dispatched.predecessorRunId,
    runId: String(runId),
  };
}

function successfulPublicationEvents(state, name) {
  return state.events.filter(([candidate]) => candidate === name);
}

test("30 Tickets converge through unique publications, Continuations, reconciliation, and one Final Review", async () => {
  const state = new StatefulQueueFake();
  let runId = 1000;
  let invocation = {
    baseBranch: "main",
    integrationBranch,
    operation: "start",
    runId: String(runId),
  };
  let finalResult = null;

  for (let invocationCount = 0; invocationCount < 33; invocationCount += 1) {
    try {
      const result = await executeInvocation(state, invocation);
      if (result.status === "ready-for-human-review") {
        finalResult = result;
        break;
      }
      assert.ok(
        result.status === "continued" ||
          result.status === "final-review-dispatched",
        `unexpected workflow-host result: ${JSON.stringify(result)}`,
      );
      invocation = nextInvocation(state, ++runId);
    } catch (error) {
      assert.match(error.message, /injected crash after push verification/u);
      assert.equal(state.currentTicket, state.crashTicket);
      invocation = {
        baseBranch: "main",
        expectedHead: state.integrationHead,
        integrationBranch,
        operation: "resume",
        predecessorRunId: invocation.runId,
        runId: String(++runId),
      };
    }
  }

  assert.ok(
    finalResult,
    "Queue Protocol exceeded 33 workflow-host invocations without converging",
  );
  assert.equal(finalResult.status, "ready-for-human-review");
  assert.equal(finalResult.verdict, "pass");

  const ticketSessions = successfulPublicationEvents(state, "sandcastle")
    .filter(([, role]) => role === "ticket")
    .map(([, , , issue]) => issue);
  const expectedOrder = [
    201, 203, 204, 205, 202,
    ...Array.from({ length: 25 }, (_, index) => index + 206),
  ];
  assert.deepEqual(ticketSessions, expectedOrder);
  assert.equal(ticketSessions.length, 30);
  assert.equal(new Set(ticketSessions).size, 30);
  assert.equal(state.sessionIds.length, 30);
  assert.equal(new Set(state.sessionIds).size, 30);
  const ticketRunIds = successfulPublicationEvents(state, "sandcastle")
    .filter(([, role]) => role === "ticket")
    .map(([, , runId]) => runId);
  assert.equal(new Set(ticketRunIds).size, 30);
  assert.equal(
    successfulPublicationEvents(state, "addLabel").filter(
      ([, issue]) => issue >= 201 && issue <= 230,
    ).length,
    30,
  );

  assert.equal(state.completionCommits.length, 30);
  assert.equal(new Set(state.completionCommits).size, 30);
  const publishedTickets = successfulPublicationEvents(state, "marker").map(
    ([, issue]) => issue,
  );
  const closedTickets = successfulPublicationEvents(state, "close").map(
    ([, issue]) => issue,
  );
  assert.equal(publishedTickets.length, 30);
  assert.equal(new Set(publishedTickets).size, 30);
  assert.equal(closedTickets.length, 30);
  assert.equal(new Set(closedTickets).size, 30);
  assert.equal(state.issues.get(state.crashTicket).state, "closed");
  assert.equal(
    ticketSessions.filter((issue) => issue === state.crashTicket).length,
    1,
  );

  const progressDispatches = successfulPublicationEvents(state, "dispatch")
    .filter(([, operation]) =>
      operation === "continue" || operation === "final-review",
    )
    .map(([, , payload]) => payload.inputs.expected_head);
  assert.deepEqual(progressDispatches, state.completionCommits);
  assert.equal(new Set(progressDispatches).size, 30);

  for (const issue of ticketSessions) {
    const pushIndex = state.events.findIndex(
      ([name, candidate]) => name === "push" && candidate === issue,
    );
    const completionHead = state.events[pushIndex][4];
    const verificationIndex = state.events.findIndex(
      ([name, branch, head], index) =>
        index > pushIndex &&
        name === "remoteHead" &&
        branch === integrationBranch &&
        head === completionHead,
    );
    const closeIndex = state.events.findIndex(
      ([name, candidate]) => name === "close" && candidate === issue,
    );
    assert.ok(pushIndex >= 0, `Ticket ${issue} must push`);
    assert.ok(
      verificationIndex > pushIndex,
      `Ticket ${issue} must verify remote HEAD after push`,
    );
    assert.ok(
      closeIndex > verificationIndex,
      `Ticket ${issue} must close after remote verification`,
    );
  }

  assert.equal(
    state.events.some(
      ([name, page]) => name === "listOpenIssues" && page === 2,
    ),
    true,
  );
  for (const issue of ticketSessions) {
    assert.ok(
      state.events.filter(
        ([name, candidate]) => name === "getIssue" && candidate === issue,
      ).length >= 2,
      `Ticket ${issue} must be fresh-read`,
    );
  }
  assert.equal(state.issues.get(150).state, "open");
  assert.equal(state.issues.get(151).state, "open");
  assert.equal(ticketSessions.includes(150), false);
  assert.equal(ticketSessions.includes(151), false);

  const finalReviewDispatches = successfulPublicationEvents(
    state,
    "dispatch",
  ).filter(([, operation]) => operation === "final-review");
  assert.equal(finalReviewDispatches.length, 1);
  assert.equal(
    successfulPublicationEvents(state, "sandcastle").filter(
      ([, role]) => role === "final-review",
    ).length,
    1,
  );
  assert.ok(
    state.events.indexOf(finalReviewDispatches[0]) >
      state.events.findLastIndex(([name]) => name === "close"),
  );
  assert.equal(state.pullRequest.draft, false);
  assert.equal(
    state.sessionInputs.some(
      ({ environment }) =>
        environment.ANTHROPIC_AUTH_TOKEN !== undefined ||
        environment.ANTHROPIC_BASE_URL !== undefined,
    ),
    false,
  );
});

test("contradictory owned Ticket facts fail closed without Queue writes", async () => {
  const state = new StatefulQueueFake();
  state.issues = new Map([
    [
      99,
      {
        ...ticket(99),
        issue_dependencies_summary: undefined,
        labels: [
          { name: "ready-for-agent" },
          { name: "sandcastle" },
        ],
      },
    ],
  ]);
  state.cloneIssue = (value) => structuredClone(value);

  state.integrationHead = baseHead;
  const result = await executeInvocation(state, {
    expectedHead: baseHead,
    operation: "continue",
    predecessorRunId: "8999",
    runId: "9000",
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.reason, "contradictory-issue-99");
  assert.equal(
    state.events.some(([name]) =>
      ["addLabel", "push", "marker", "close", "dispatch"].includes(name),
    ),
    false,
  );
});
