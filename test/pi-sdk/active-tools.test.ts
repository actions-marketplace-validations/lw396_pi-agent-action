// Issue #2, AC 6: an extension can change the active tool set in the middle of
// a session. The structured-output retry needs exactly this: when the model
// stops without calling submit_result, keep only submit_result and continue.
//
// Also checks the parts of that design the spec relies on: submit_result's
// parameters can be a plain JSON Schema, arguments that do not match it are
// rejected with an error the model sees, and agent_before_settle can continue
// the run with a reminder.
import { afterEach, describe, expect, test } from "bun:test";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createFauxSession,
  declaredToolNames,
  lastToolResultText,
  toolExecutionEnds,
  type FauxSession,
} from "./harness";

const USER_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
  required: ["verdict"],
  additionalProperties: false,
};

const REMINDER = "Call submit_result with your final answer.";

type StructuredOutput = { submitted: unknown; reminders: number };

/** A minimal version of the planned structured output extension. */
function structuredOutputExtension(state: StructuredOutput) {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "submit_result",
      label: "Submit result",
      description: "Submit the final structured result.",
      // The user's JSON Schema, used as-is.
      parameters: Type.Unsafe<Record<string, unknown>>(USER_SCHEMA),
      async execute(_id, params) {
        state.submitted = params;
        return {
          content: [{ type: "text", text: "Result recorded." }],
          details: undefined,
        };
      },
    });

    pi.on("agent_before_settle", () => {
      if (state.submitted !== undefined || state.reminders >= 2) return;
      state.reminders++;
      pi.setActiveTools(["submit_result"]);
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

/** Records what each provider request declared and what it ended with. */
function recordRequest(requests: TranscriptContext[]) {
  return (context: TranscriptContext) => {
    requests.push(structuredClone(context));
  };
}

/** Everything the request added after the model's latest reply. */
function sinceLastReply(context: TranscriptContext): string {
  const messages = context.messages;
  const lastReply = messages.findLastIndex((m) => m.role === "assistant");
  return JSON.stringify(messages.slice(lastReply + 1));
}

let current: FauxSession | undefined;
afterEach(() => {
  current?.dispose();
  current = undefined;
});

describe("switching the active tool set mid-session", () => {
  test("keeps only submit_result after a reminder, and the model can submit", async () => {
    const state: StructuredOutput = { submitted: undefined, reminders: 0 };
    const requests: TranscriptContext[] = [];
    const record = recordRequest(requests);
    current = await createFauxSession({
      extensionFactories: [structuredOutputExtension(state)],
      responses: [
        (context) => {
          record(context);
          return fauxAssistantMessage("I think it passes.");
        },
        (context) => {
          record(context);
          return fauxAssistantMessage(
            fauxToolCall("submit_result", { verdict: "pass" }),
            { stopReason: "toolUse" },
          );
        },
        (context) => {
          record(context);
          return fauxAssistantMessage("Submitted.");
        },
      ],
    });
    await current.session.bindExtensions({});
    await current.session.prompt("Review this change.");

    expect(declaredToolNames(requests[0]!)).toEqual(
      expect.arrayContaining(["bash", "read", "submit_result"]),
    );
    // The reminder request: only submit_result is declared, and the reminder
    // follows the reply that did not submit (as a user-role message, then a
    // system message that removes the other tools).
    expect(declaredToolNames(requests[1]!)).toEqual(["submit_result"]);
    expect(sinceLastReply(requests[1]!)).toContain(REMINDER);
    expect(state.reminders).toBe(1);
    expect(state.submitted).toEqual({ verdict: "pass" });
    expect(current.session.getActiveToolNames()).toEqual(["submit_result"]);
  });

  test("a tool removed from the active set cannot be called", async () => {
    const state: StructuredOutput = { submitted: undefined, reminders: 0 };
    let resultSeen = "";
    current = await createFauxSession({
      extensionFactories: [structuredOutputExtension(state)],
      responses: [
        fauxAssistantMessage("done, no submission"),
        fauxAssistantMessage(fauxToolCall("bash", { command: "echo ran" }), {
          stopReason: "toolUse",
        }),
        (context) => {
          resultSeen = lastToolResultText(context);
          return fauxAssistantMessage(
            fauxToolCall("submit_result", { verdict: "fail" }),
            { stopReason: "toolUse" },
          );
        },
        fauxAssistantMessage("ok"),
      ],
    });
    await current.session.bindExtensions({});
    await current.session.prompt("go");

    const bash = toolExecutionEnds(current).find((e) => e.toolName === "bash");
    expect(bash?.isError).toBe(true);
    expect(resultSeen).toBe("Tool bash not found");
    expect(state.submitted).toEqual({ verdict: "fail" });
  });

  test("arguments that do not match the JSON Schema are rejected visibly", async () => {
    const state: StructuredOutput = { submitted: undefined, reminders: 0 };
    let validationError = "";
    current = await createFauxSession({
      extensionFactories: [structuredOutputExtension(state)],
      responses: [
        fauxAssistantMessage(
          fauxToolCall("submit_result", { verdict: "maybe" }),
          { stopReason: "toolUse" },
        ),
        (context) => {
          validationError = lastToolResultText(context);
          return fauxAssistantMessage(
            fauxToolCall("submit_result", { verdict: "pass" }),
            { stopReason: "toolUse" },
          );
        },
        fauxAssistantMessage("ok"),
      ],
    });
    await current.session.bindExtensions({});
    await current.session.prompt("go");

    expect(validationError).toContain("verdict");
    expect(state.submitted).toEqual({ verdict: "pass" });
    expect(state.reminders).toBe(0);
  });

  test("stops after two unanswered reminders", async () => {
    const state: StructuredOutput = { submitted: undefined, reminders: 0 };
    current = await createFauxSession({
      extensionFactories: [structuredOutputExtension(state)],
      responses: [
        fauxAssistantMessage("no"),
        fauxAssistantMessage("still no"),
        fauxAssistantMessage("never"),
      ],
    });
    await current.session.bindExtensions({});
    await current.session.prompt("go");

    expect(state.reminders).toBe(2);
    expect(state.submitted).toBeUndefined();
    expect(current.faux.getPendingResponseCount()).toBe(0);
    expect(current.faux.state.callCount).toBe(3);
  });
});
