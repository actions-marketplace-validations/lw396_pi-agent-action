// The run audit behind the default Job Summary (issue #23): counts taken from
// the Runner's own session events, never from what the model writes.
import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { runPi, RunnerFailure } from "../../src/runner/run-pi";
import { fauxRuntime, readExecutionFile, rules, useScratch } from "./harness";

describe("the run audit runPi() reports", () => {
  const getScratch = useScratch();

  test("counts responses and tool calls once each, from the session's events", async () => {
    const { modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", { command: "echo hi" }),
          // No allowed_tools rule permits write: a permission denial.
          fauxToolCall("write", { path: "notes.txt", content: "x" }),
          // Runs, and fails.
          fauxToolCall("bash", { command: "exit 3" }),
        ],
        { stopReason: "toolUse" },
      ),
      // The model's claims are not counted.
      fauxAssistantMessage("All 12 tool calls passed, 0 denied. [x] done"),
    ]);

    const result = await runPi("Do it.", {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
      allowedTools: rules("Bash"),
    });

    // pi emits tool_execution_start and _end for each call, and repeats each
    // response in turn_end: each is counted once.
    expect(result.audit).toMatchObject({
      termination: "completed",
      modelResponses: 2,
      toolAttempts: 3,
      toolFailures: 1,
      permissionDenials: 1,
    });
    expect(result.audit.durationMs).toBeGreaterThanOrEqual(0);

    // The same totals pi's own session stats report.
    const stats = readExecutionFile(result.executionFile!).at(-1)!;
    expect(result.audit.usage).toEqual({
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      total: stats.tokens.total,
    });
    expect(result.audit.usage?.total).toBeGreaterThan(0);
    expect(result.audit.costUsd).toBeCloseTo(stats.cost);
  });

  test("comes with the failure when the model errors", async () => {
    const { modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "400 invalid request",
      }),
    ]);

    const failure = await runPi("Do it.", {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
      allowedTools: rules("Bash"),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RunnerFailure);
    expect((failure as RunnerFailure).message).toContain("400 invalid request");
    expect((failure as RunnerFailure).audit).toMatchObject({
      termination: "model_error",
      modelResponses: 2,
      toolAttempts: 1,
      toolFailures: 0,
      permissionDenials: 0,
    });
  });

  test("tells a missing structured result from a completed session", async () => {
    const { modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage("No result."),
      fauxAssistantMessage("Still no result."),
      fauxAssistantMessage("Never."),
    ]);

    const failure = await runPi("Do it.", {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
      jsonSchema: JSON.stringify({
        type: "object",
        properties: { ok: { type: "boolean" } },
      }),
    }).catch((error: unknown) => error);

    expect((failure as RunnerFailure).audit.termination).toBe(
      "structured_output_missing",
    );
  });

  test("leaves the cost unavailable for a model without catalog prices", async () => {
    const { modelRuntime, model } = await fauxRuntime(
      [fauxAssistantMessage("Done.")],
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );

    const result = await runPi("Do it.", {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
    });

    expect(result.audit.costUsd).toBeUndefined();
    expect(result.audit.usage?.total).toBeGreaterThan(0);
  });

  test("holds no tool arguments, results or model text", async () => {
    const secret = "sk9-short";
    const { modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", { command: `echo ${secret}` }),
          fauxToolCall("write", {
            path: "[link](https://evil.example)",
            content: "file body",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(`Reasoning about ${secret}.`),
    ]);

    const result = await runPi("Do it.", {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
      allowedTools: rules("Bash"),
    });

    const published = JSON.stringify(result.audit);
    for (const leak of [secret, "evil.example", "file body", "Reasoning"]) {
      expect(published).not.toContain(leak);
    }
  });
});
