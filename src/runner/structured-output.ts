import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PiArgs } from "./pi-args";
import type { ToolRule } from "./tool-rules";

/** The tool the model calls with its result when json_schema is set. */
export const SUBMIT_RESULT_TOOL = "submit_result";

/** Reminders sent when the model stops without submitting, before failing. */
export const MAX_REMINDERS = 2;

const REMINDER = `You have not submitted your result. Call ${SUBMIT_RESULT_TOOL} now, with your final result as its arguments. The run fails if you do not.`;

/** What the extension records during the run. */
type StructuredOutputState = {
  /** The arguments of the latest valid submit_result call. */
  result?: Record<string, unknown>;
  reminders: number;
};

/**
 * Parse the json_schema input: a JSON Schema for an object, which becomes
 * submit_result's parameters. Providers only accept object parameters, and
 * upstream's structured_output is an object of named fields, so other schemas
 * are refused before the model starts.
 */
function parseJsonSchema(
  input: string | undefined,
): Record<string, unknown> | undefined {
  if (!input?.trim()) return undefined;
  let schema: unknown;
  try {
    schema = JSON.parse(input);
  } catch (error) {
    throw new Error(
      `The json_schema input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof schema !== "object" ||
    schema === null ||
    Array.isArray(schema) ||
    (schema as Record<string, unknown>).type !== "object"
  ) {
    throw new Error(
      'The json_schema input must describe an object: a JSON Schema with "type": "object" and the fields in "properties".',
    );
  }
  return schema as Record<string, unknown>;
}

/**
 * The structured output extension: registers submit_result with the
 * json_schema input as its parameters. pi validates each call against the
 * schema and returns any errors to the model, which can then call again.
 *
 * If the model stops without submitting, it is reminded, with every other
 * tool removed, up to MAX_REMINDERS times. The Runner fails the run when there
 * is still no result.
 */
function structuredOutputExtension(
  schema: Record<string, unknown>,
  state: StructuredOutputState,
): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: SUBMIT_RESULT_TOOL,
      label: "Submit result",
      description:
        "Submit the final result of the task. Its arguments are the result. Call it once, when the task is done; the run ends after it.",
      promptSnippet: "Submit the final result of the task",
      promptGuidelines: [
        `When the task is done, call ${SUBMIT_RESULT_TOOL} with the final result. The run fails without it.`,
      ],
      parameters: Type.Unsafe<Record<string, unknown>>(schema),
      async execute(_toolCallId, params) {
        state.result = params;
        return {
          content: [{ type: "text", text: "Result submitted." }],
          details: params,
          terminate: true,
        };
      },
    });

    pi.on("agent_before_settle", (event) => {
      if (event.outcome !== "completed") return;
      if (state.result !== undefined || state.reminders >= MAX_REMINDERS) {
        return;
      }
      state.reminders++;
      pi.setActiveTools([SUBMIT_RESULT_TOOL]);
      return {
        continue: true,
        entries: [
          {
            type: "custom_message",
            customType: "structured-output-reminder",
            content: REMINDER,
            display: true,
          },
        ],
      };
    });
  };
}

/** Everything the Runner does differently when json_schema is set. */
export type StructuredOutput = {
  /** Submitting the result needs no rule; disallowed_tools can still block it. */
  allowRule: ToolRule;
  extension: ExtensionFactory;
  /**
   * The session's tools list. A --tools list or --no-tools from pi_args would
   * leave out submit_result: pi activates only the tools a list names, and
   * `tools` wins over `noTools`.
   */
  sessionTools(piArgs: PiArgs): string[] | undefined;
  /** Why the session cannot submit a result, given its active tools. */
  toolsProblem(activeTools: string[]): string | undefined;
  /** Why the run failed for want of a result, once the session has ended. */
  failure(): string | undefined;
  /** The submitted result as JSON, for the structured_output output. */
  output(): string | undefined;
};

/**
 * Structured output for the json_schema input, or undefined when it is not
 * set. Throws on a schema the action cannot use.
 */
export function createStructuredOutput(
  input: string | undefined,
): StructuredOutput | undefined {
  const schema = parseJsonSchema(input);
  if (!schema) return undefined;
  const state: StructuredOutputState = { reminders: 0 };
  return {
    allowRule: { text: "json_schema", tool: SUBMIT_RESULT_TOOL },
    extension: structuredOutputExtension(schema, state),
    sessionTools({ tools, noTools }) {
      // pi rejects a list that mixes names with +name/-name entries.
      if (tools?.length && tools.every((t) => /^[+-]/.test(t))) {
        return [...tools, `+${SUBMIT_RESULT_TOOL}`];
      }
      if (tools) return [...tools, SUBMIT_RESULT_TOOL];
      if (noTools === "all") return [SUBMIT_RESULT_TOOL];
      return undefined;
    },
    toolsProblem(activeTools) {
      if (activeTools.includes(SUBMIT_RESULT_TOOL)) return undefined;
      return `pi_args leaves out the ${SUBMIT_RESULT_TOOL} tool, which json_schema needs. Remove it from --exclude-tools.`;
    },
    failure() {
      if (state.result !== undefined) return undefined;
      return `the model did not call ${SUBMIT_RESULT_TOOL}, which json_schema requires, after ${state.reminders} reminders`;
    },
    output() {
      return state.result !== undefined
        ? JSON.stringify(state.result)
        : undefined;
    },
  };
}
