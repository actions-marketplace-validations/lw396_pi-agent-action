// The export_session input through runPi() (issue #25): a real, in-memory
// pi session driven by the faux provider, exported after it ends.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { runPi, RunnerFailure } from "../../src/runner/run-pi";
import { fauxRuntime, readExecutionFile, rules, useScratch } from "./harness";

describe("runPi() with exportSession", () => {
  const getScratch = useScratch();
  const exportDir = () => join(process.env.RUNNER_TEMP!, "pi-session-export");

  test("exports nothing by default", async () => {
    const { modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage("Done."),
    ]);

    const result = await runPi("Do it.", {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
    });

    expect(result.sessionExport).toBeUndefined();
    expect(existsSync(exportDir())).toBe(false);
  });

  test("exports the session it ran, outside the checkout", async () => {
    const { modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Said hi."),
    ]);

    const result = await runPi("Say hi with bash.", {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
      allowedTools: rules("Bash"),
      exportSession: true,
    });

    expect(result.sessionExport).toEqual({
      jsonl: join(exportDir(), "pi-session.jsonl"),
      html: join(exportDir(), "pi-session.html"),
    });
    expect(result.sessionExport!.jsonl!.startsWith(getScratch().cwd)).toBe(
      false,
    );
    const exported = SessionManager.open(result.sessionExport!.jsonl!);
    expect(exported.getHeader()?.id).toBe(result.sessionId!);
    const roles = exported
      .getBranch()
      .flatMap((entry) =>
        entry.type === "message" ? [entry.message.role] : [],
      );
    expect(roles).toEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const jsonl = await Bun.file(result.sessionExport!.jsonl!).text();
    expect(jsonl).toContain("echo hi");
    expect(jsonl).toContain("Said hi.");
    expect(readdirSync(exportDir()).sort()).toEqual([
      "pi-session.html",
      "pi-session.jsonl",
    ]);

    // The Execution file is unchanged: still pi's events, as a JSON array.
    const records = readExecutionFile(result.executionFile!);
    expect(records.at(-1)!.type).toBe("session_stats");
  });

  test("exports a session that failed, with the failure", async () => {
    const { modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "400 invalid request",
      }),
    ]);

    const failure = await runPi("Do it.", {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
      exportSession: true,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RunnerFailure);
    const { sessionExport } = failure as RunnerFailure;
    expect(sessionExport?.html).toBe(join(exportDir(), "pi-session.html"));
    expect(await Bun.file(sessionExport!.jsonl!).text()).toContain(
      "400 invalid request",
    );
  });
});
