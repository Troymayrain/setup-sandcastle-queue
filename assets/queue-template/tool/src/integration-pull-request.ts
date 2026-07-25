export interface IntegrationPullRequest {
  draft: boolean;
  nodeId?: string;
  number: number;
  state?: string;
  url: string;
}

export interface DraftPullRequest extends IntegrationPullRequest {
  draft: true;
}

export interface IntegrationPullRequestBoundary {
  createDraftPullRequest(input: {
    base: string;
    head: string;
    title: string;
  }): Promise<DraftPullRequest>;
  listIntegrationPullRequests(input: {
    base: string;
    head: string;
  }): Promise<IntegrationPullRequest[]>;
}

export async function ensureIntegrationPullRequest(
  branches: { baseBranch: string; integrationBranch: string },
  boundary: IntegrationPullRequestBoundary,
): Promise<DraftPullRequest | null> {
  const input = {
    base: branches.baseBranch,
    head: branches.integrationBranch,
  };
  const existing = await boundary.listIntegrationPullRequests(input);
  if (existing.length > 1) return null;
  if (existing[0]) {
    return existing[0].draft === true && existing[0].state !== "closed"
      ? { ...existing[0], draft: true }
      : null;
  }
  const created = await boundary.createDraftPullRequest({
    ...input,
    title: "Sandcastle Queue integration",
  });
  return created.draft === true ? created : null;
}
