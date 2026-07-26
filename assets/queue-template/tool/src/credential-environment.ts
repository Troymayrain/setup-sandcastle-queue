const executionCredentialNames = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "GITHUB_TOKEN",
] as const;

const credentialNamePattern =
  /(?:API_KEY|AUTH|CREDENTIAL|PASSWORD|PRIVATE_KEY|SECRET|TOKEN|ACCESS_KEY)/iu;

export function executionCredentialValues(
  environment: NodeJS.ProcessEnv,
): string[] {
  return Object.entries(environment)
    .filter(
      ([name, value]) =>
        value !== undefined &&
        (executionCredentialNames.includes(
          name as (typeof executionCredentialNames)[number],
        ) || credentialNamePattern.test(name)),
    )
    .map(([, value]) => value!);
}

export function withoutExecutionCredentials(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const name of executionCredentialNames) delete result[name];
  return result;
}
