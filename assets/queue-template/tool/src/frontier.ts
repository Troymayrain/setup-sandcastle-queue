export interface GitHubIssue {
  assignees?: Array<{ login: string }>;
  body?: string | null;
  issue_dependencies_summary?: { blocked_by: number };
  labels?: Array<{ name: string }>;
  number: number;
  pull_request?: unknown;
  state?: string;
}

export interface FrontierGitHub {
  addLabel(issue: number, label: string): Promise<void>;
  getIssue(issue: number): Promise<GitHubIssue>;
  listOpenIssues(page: number): Promise<GitHubIssue[]>;
}

export type FrontierResult =
  | { activated: number[]; body: string; status: "ready"; ticket: number }
  | { activated: number[]; reason: "assigned" | "blocked" | "empty"; status: "waiting" }
  | { activated: number[]; reason: string; status: "conflict" };

const requiredHeadings = [
  "## What to build",
  "## Acceptance criteria",
  "## Blocked by",
] as const;

export function validateTicketContract(body: string | null | undefined): boolean {
  if (!body) return false;
  const headings = [...body.matchAll(/^## .+$/gmu)].map(({ 0: heading }) => heading.trim());
  for (const heading of requiredHeadings) {
    if (headings.filter((candidate) => candidate === heading).length !== 1) return false;
    const start = body.indexOf(heading) + heading.length;
    const next = body.slice(start).search(/^## .+$/mu);
    const section = body.slice(start, next < 0 ? undefined : start + next).trim();
    if (!section) return false;
    if (heading === "## Acceptance criteria" && !/^- \[ \] .+/mu.test(section)) {
      return false;
    }
  }
  return true;
}

function hasLabel(issue: GitHubIssue, expected: string): boolean {
  return (
    issue.labels?.some(({ name }) => name.toLowerCase() === expected.toLowerCase()) ??
    false
  );
}

function structurallyComplete(issue: GitHubIssue): boolean {
  return (
    issue.state === "open" &&
    issue.pull_request === undefined &&
    Array.isArray(issue.labels) &&
    Array.isArray(issue.assignees) &&
    issue.issue_dependencies_summary !== undefined &&
    Number.isSafeInteger(issue.issue_dependencies_summary.blocked_by) &&
    issue.issue_dependencies_summary.blocked_by >= 0
  );
}

async function allOpenIssues(client: FrontierGitHub): Promise<GitHubIssue[]> {
  const issues: GitHubIssue[] = [];
  for (let page = 1; ; page += 1) {
    const current = await client.listOpenIssues(page);
    issues.push(...current);
    if (current.length < 100) return issues;
  }
}

export async function activateAndSelectFrontier(
  client: FrontierGitHub,
  labels: { ownership: string; ready: string },
  activate: boolean,
  completedTicket?: number,
): Promise<FrontierResult> {
  const listed = await allOpenIssues(client);
  if (new Set(listed.map(({ number }) => number)).size !== listed.length) {
    return { activated: [], reason: "duplicate-list-facts", status: "conflict" };
  }

  const activated: number[] = [];
  if (activate) {
    for (const snapshot of listed.sort((left, right) => left.number - right.number)) {
      if (snapshot.pull_request !== undefined || !hasLabel(snapshot, labels.ready)) {
        continue;
      }
      const issue = await client.getIssue(snapshot.number);
      if (issue.number !== snapshot.number || !structurallyComplete(issue)) {
        return {
          activated,
          reason: `missing-activation-facts-${snapshot.number}`,
          status: "conflict",
        };
      }
      if (
        !hasLabel(issue, labels.ready) ||
        (issue.assignees?.length ?? 0) > 0 ||
        !validateTicketContract(issue.body)
      ) {
        continue;
      }
      if (!hasLabel(issue, labels.ownership)) {
        await client.addLabel(issue.number, labels.ownership);
        const visible = await client.getIssue(issue.number);
        if (!hasLabel(visible, labels.ownership)) {
          return { activated, reason: "ownership-label-not-visible", status: "conflict" };
        }
      }
      activated.push(issue.number);
    }
  }

  const refreshedList = await allOpenIssues(client);
  let waitingReason: "assigned" | "blocked" | "empty" = "empty";
  const executable: GitHubIssue[] = [];
  for (const snapshot of refreshedList.sort((left, right) => left.number - right.number)) {
    const issue = await client.getIssue(snapshot.number);
    if (snapshot.number === completedTicket) {
      if (issue.number !== snapshot.number || issue.state !== "closed") {
        return {
          activated,
          reason: `contradictory-issue-${snapshot.number}`,
          status: "conflict",
        };
      }
      continue;
    }
    if (issue.number !== snapshot.number || !Array.isArray(issue.labels)) {
      return {
        activated,
        reason: `contradictory-issue-${snapshot.number}`,
        status: "conflict",
      };
    }
    if (!hasLabel(issue, labels.ownership)) continue;
    if (
      !structurallyComplete(issue) ||
      !hasLabel(issue, labels.ownership) ||
      !hasLabel(issue, labels.ready) ||
      !validateTicketContract(issue.body)
    ) {
      return {
        activated,
        reason: `contradictory-issue-${snapshot.number}`,
        status: "conflict",
      };
    }
    if ((issue.assignees?.length ?? 0) > 0) {
      waitingReason = "assigned";
      continue;
    }
    if ((issue.issue_dependencies_summary?.blocked_by ?? 0) > 0) {
      waitingReason = "blocked";
      continue;
    }
    executable.push(issue);
  }
  if (executable[0] !== undefined) {
    return {
      activated,
      body: executable[0].body!,
      status: "ready",
      ticket: executable[0].number,
    };
  }
  return { activated, reason: waitingReason, status: "waiting" };
}
