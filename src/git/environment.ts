export type GitConfigEntry = readonly [key: string, value: string];

const hostIdentityVariables = [
  "GIT_AUTHOR_DATE",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_DATE",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME",
] as const;

const hostSafetyConfig: readonly GitConfigEntry[] = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["credential.helper", ""],
  ["protocol.ext.allow", "never"],
];

/**
 * Build a minimal Git environment for host-side operations on an untrusted
 * repository. Repository data remains visible, but executable helpers from
 * ambient configuration and repository-local hooks are disabled.
 */
export function createHostGitEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  additionalConfig: readonly GitConfigEntry[] = [],
): NodeJS.ProcessEnv {
  const config = [...hostSafetyConfig, ...additionalConfig];
  const result: NodeJS.ProcessEnv = {
    GIT_CONFIG_COUNT: String(config.length),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_PAGER: "cat",
    GIT_SSH_COMMAND: "/bin/false",
    GIT_TERMINAL_PROMPT: "0",
    PATH: environment.PATH,
  };
  for (const name of hostIdentityVariables) {
    if (environment[name] !== undefined) result[name] = environment[name];
  }
  config.forEach(([key, value], index) => {
    result[`GIT_CONFIG_KEY_${index}`] = key;
    result[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return result;
}
