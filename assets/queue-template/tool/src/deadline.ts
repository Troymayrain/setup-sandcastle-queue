export type DeadlinePublicationFact =
  | { head: string; status: "complete"; ticket: number }
  | { status: "absent" }
  | { status: "unknown" };

export class ProcessingDeadlineError extends Error {
  readonly status: "publication-unknown" | "ticket-deadline-exceeded";

  constructor(status: ProcessingDeadlineError["status"]) {
    super(status);
    this.name = "ProcessingDeadlineError";
    this.status = status;
  }
}

export interface DeadlineScheduler {
  clearTimeout(handle: unknown): void;
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
}

export interface DeadlineLifecycle {
  onBeforeHead(head: string): void;
  onExecutionComplete(): void;
  signal: AbortSignal;
}

const realScheduler: DeadlineScheduler = {
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
};

export async function runWithTicketDeadline<
  Result extends {
    completionCommit: string;
    status: string;
    ticket: number;
  },
>(
  options: {
    hardDeadlineAtMs: number;
    reserveMinutes: number;
    ticket: number;
  },
  execute: (lifecycle: DeadlineLifecycle) => Promise<Result>,
  readPublication: (input: {
    beforeHead: string;
    ticket: number;
  }) => Promise<DeadlinePublicationFact>,
  scheduler: DeadlineScheduler = realScheduler,
): Promise<Result | { completionCommit: string; status: "published"; ticket: number }> {
  if (
    !Number.isFinite(options.hardDeadlineAtMs) ||
    !Number.isSafeInteger(options.reserveMinutes) ||
    options.reserveMinutes <= 0 ||
    !Number.isSafeInteger(options.ticket) ||
    options.ticket <= 0
  ) {
    throw new Error("Ticket deadline configuration is invalid.");
  }

  const controller = new AbortController();
  let beforeHead: string | undefined;
  let executionComplete = false;
  let timedOut = false;
  const delay = Math.max(
    0,
    options.hardDeadlineAtMs -
      options.reserveMinutes * 60_000 -
      scheduler.now(),
  );
  const handle = scheduler.setTimeout(() => {
    if (executionComplete) return;
    timedOut = true;
    controller.abort(new Error("Ticket deadline reached."));
  }, delay);
  const clear = () => scheduler.clearTimeout(handle);

  try {
    const result = await execute({
      onBeforeHead: (head) => {
        beforeHead = head;
      },
      onExecutionComplete: () => {
        executionComplete = true;
        clear();
      },
      signal: controller.signal,
    });
    if (!timedOut) {
      clear();
      return result;
    }
  } catch (error) {
    clear();
    if (!timedOut) throw error;
  }

  if (!beforeHead) {
    throw new ProcessingDeadlineError("publication-unknown");
  }
  let publication: DeadlinePublicationFact;
  try {
    publication = await readPublication({
      beforeHead,
      ticket: options.ticket,
    });
  } catch {
    throw new ProcessingDeadlineError("publication-unknown");
  }
  if (publication.status === "absent") {
    throw new ProcessingDeadlineError("ticket-deadline-exceeded");
  }
  if (
    publication.status !== "complete" ||
    publication.ticket !== options.ticket
  ) {
    throw new ProcessingDeadlineError("publication-unknown");
  }
  return {
    completionCommit: publication.head,
    status: "published",
    ticket: publication.ticket,
  };
}
