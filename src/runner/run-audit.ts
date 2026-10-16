import type {
  AgentSessionEvent,
  SessionStats,
} from "@earendil-works/pi-coding-agent";

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

/**
 * Token counts in pi's categories, as pi's session stats total them over the
 * responses; input does not include cached tokens.
 */
export type RunUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** The sum of the four. */
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
  /**
   * In US dollars, as pi prices the usage from its model catalog. Unset for a
   * model the catalog has no prices for, rather than a cost of 0.
   */
  costUsd?: number;
};

/** What the session reports at its end, besides its events. */
export type SessionEnd = {
  termination: Termination;
  durationMs: number;
  stats: Pick<SessionStats, "tokens" | "cost">;
  /** The model has prices in pi's catalog. */
  priced: boolean;
};

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

    audit({ termination, durationMs, stats, priced }: SessionEnd): RunAudit {
      const failures = [...failed].filter((id) => !denied.has(id));
      const { tokens } = stats;
      return {
        termination,
        durationMs,
        modelResponses: responses.size,
        toolAttempts: attempted.size,
        toolFailures: failures.length,
        permissionDenials: denied.size,
        usage: {
          input: tokens.input,
          output: tokens.output,
          cacheRead: tokens.cacheRead,
          cacheWrite: tokens.cacheWrite,
          total: tokens.total,
        },
        costUsd: priced ? stats.cost : undefined,
      };
    },
  };
}

export type AuditCollector = ReturnType<typeof createAuditCollector>;
