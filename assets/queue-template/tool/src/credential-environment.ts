const executionCredentialNames = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "GITHUB_TOKEN",
] as const;

export function withoutExecutionCredentials(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const name of executionCredentialNames) delete result[name];
  return result;
}
