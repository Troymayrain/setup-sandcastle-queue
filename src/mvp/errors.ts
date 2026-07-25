export type ExitCode = 2 | 3 | 4;

export class CliError extends Error {
  readonly code: string;
  readonly details?: object;
  readonly exitCode: ExitCode;

  constructor(exitCode: ExitCode, code: string, message: string, details?: object) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
  }
}
