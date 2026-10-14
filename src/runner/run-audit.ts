import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * How the pi session ended. It describes the session, not the task: a
 * "completed" session may still have left the task undone.
 */
export type Termination =
  /** The model ended its turn. */
  | "completed"
  /** The last response stopped at the model's output limit. */
  | "output_limit"
  /** The provider returned an error, after pi's own retries. */
  | "model_error"
  | "aborted"
  | "no_response"
  /** json_schema was set and the model never called submit_result. */
  | "structured_output_missing"
  /** prompt() threw: the Runner failed while the session was running. */
  | "runner_error";

/** Token counts in pi's categories; input does not include cached tokens. */
export type RunUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** The sum of the four, known only when all four are. */
  total?: number;
};

/**
 * The run audit: counts and categories only, taken from the session's
 * events, safe to publish. It holds no text the model, a tool or the
 * repository wrote. An unset value is unavailable, not zero.
 */
export type RunAudit = {
  termination: Termination;
  durationMs?: number;
  /** Assistant messages: one per model response, errors included. */
  modelResponses?: number;
  /** Tool calls the session started, blocked ones and nested ones included. */
  toolAttempts?: number;
  /** Calls that ran and returned an error; permission denials are not included. */
  toolFailures?: number;
  /** Calls the allowed_tools and disallowed_tools rules blocked. */
  permissionDenials?: number;
  usage?: RunUsage;
  /** In US dollars, as pi prices the usage from its model catalog. */
  costUsd?: number;
};

/** A Runner session that failed, with the audit of what it did. */
export class RunnerFailure extends Error {
  constructor(
    message: string,
    readonly audit: RunAudit,
  ) {
    super(message);
    this.name = "RunnerFailure";
  }
}

const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/**
 * Collects the audit from a session's events and the tool permission
 * extension's denials. Each response and each tool call is counted once,
 * however many events repeat it.
 */
export function createAuditCollector() {
  const responses = new Set<object>();
  const attempted = new Set<string>();
  const failed = new Set<string>();
  const denied = new Set<string>();

  return {
    /** Subscribe this to the session. */
    observe(event: AgentSessionEvent): void {
      if (event.type === "message_end") {
        if (event.message.role === "assistant") responses.add(event.message);
      } else if (event.type === "tool_execution_start") {
        attempted.add(event.toolCallId);
      } else if (event.type === "tool_execution_end") {
        attempted.add(event.toolCallId);
        if (event.isError === true) failed.add(event.toolCallId);
      }
    },

    /** The tool permission extension blocked this call. */
    denied(toolCallId: string): void {
      attempted.add(toolCallId);
      denied.add(toolCallId);
    },

    audit(termination: Termination, durationMs: number): RunAudit {
      const messages = [...responses];
      const failures = [...failed].filter((id) => !denied.has(id));
      return {
        termination,
        durationMs,
        modelResponses: messages.length,
        toolAttempts: attempted.size,
        toolFailures: failures.length,
        permissionDenials: denied.size,
        usage: usageOf(messages),
        costUsd: sumOf(messages, (usage) =>
          isObject(usage.cost) ? usage.cost.total : undefined,
        ),
      };
    },
  };
}

export type AuditCollector = ReturnType<typeof createAuditCollector>;

function usageOf(messages: object[]): RunUsage {
  const usage: RunUsage = {};
  for (const key of USAGE_KEYS) {
    usage[key] = sumOf(messages, (reported) => reported[key]);
  }
  const parts = USAGE_KEYS.map((key) => usage[key]);
  if (parts.every((part) => part !== undefined)) {
    usage.total = parts.reduce((sum, part) => sum + part, 0);
  }
  return usage;
}

/** The sum over the responses' usage, or undefined if one did not report it. */
function sumOf(
  messages: object[],
  pick: (usage: Record<string, unknown>) => unknown,
): number | undefined {
  let sum = 0;
  for (const message of messages) {
    const usage = (message as { usage?: unknown }).usage;
    const value = isObject(usage) ? pick(usage) : undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return undefined;
    }
    sum += value;
  }
  return sum;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
