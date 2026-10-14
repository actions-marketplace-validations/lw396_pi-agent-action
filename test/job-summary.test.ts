// The safe run summary the action writes to the Job Summary by default
// (issue #23), and how it sits next to the detailed pi Agent Report.
import * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  formatRunAudit,
  writeJobSummary,
} from "../src/entrypoints/job-summary";
import type { RunAudit } from "../src/runner/run-audit";

const audit: RunAudit = {
  termination: "completed",
  durationMs: 29 * 60_000 + 12_400,
  modelResponses: 41,
  toolAttempts: 1234,
  toolFailures: 0,
  permissionDenials: 2,
  usage: {
    input: 120_500,
    output: 8_200,
    cacheRead: 2_400_000,
    cacheWrite: 61_000,
    total: 2_589_700,
  },
  costUsd: 1.23456,
};

describe("formatRunAudit", () => {
  test("shows the counts, usage and estimated cost of the run", () => {
    const markdown = formatRunAudit(audit);

    expect(markdown).toContain("## pi run summary");
    expect(markdown).toContain("| Session status | Completed |");
    expect(markdown).toContain("| Duration | 29m 12s |");
    expect(markdown).toContain("| Model responses | 41 |");
    expect(markdown).toContain("| Tool calls attempted | 1,234 |");
    expect(markdown).toContain("| Tool calls failed | 0 |");
    expect(markdown).toContain("| Permission denials | 2 |");
    expect(markdown).toContain(
      "| 120,500 | 8,200 | 2,400,000 | 61,000 | 2,589,700 |",
    );
    expect(markdown).toContain("$1.2346");
    // The status is the session's, not a verdict on the task.
    expect(markdown).toContain("not whether the task");
    expect(markdown).toContain("estimate");
  });

  test("names each way a session can end", () => {
    const labels: [RunAudit["termination"], string][] = [
      ["output_limit", "Stopped at the output limit"],
      ["model_error", "Model error"],
      ["aborted", "Aborted"],
      ["no_response", "No model response"],
      ["structured_output_missing", "No structured result"],
      ["runner_error", "Runner error"],
    ];
    for (const [termination, label] of labels) {
      expect(formatRunAudit({ termination })).toContain(
        `| Session status | ${label} |`,
      );
    }
  });

  test("marks missing values unavailable rather than zero", () => {
    const markdown = formatRunAudit({
      termination: "runner_error",
      modelResponses: 3,
      usage: { input: 10, output: 5 },
    });

    expect(markdown).toContain("| Model responses | 3 |");
    expect(markdown).toContain("| Duration | unavailable |");
    expect(markdown).toContain("| Tool calls attempted | unavailable |");
    expect(markdown).toContain(
      "| 10 | 5 | unavailable | unavailable | unavailable |",
    );
    expect(markdown).toContain("Estimated cost: unavailable");
  });

  test("says so when the Runner stopped before the session reported anything", () => {
    const markdown = formatRunAudit(undefined);

    expect(markdown).toContain("| Session status | Runner error |");
    expect(markdown).toContain("Statistics are unavailable");
    expect(markdown).not.toMatch(/\| 0 \|/);
  });

  test("publishes no string it was not written with", () => {
    const hostile = {
      termination: "[pwn](https://evil.example/a)",
      durationMs: "<img src=x onerror=alert(1)>",
      modelResponses: "ghp_short",
      toolAttempts: Number.NaN,
      toolFailures: -1,
      permissionDenials: 1.5,
      usage: {
        input: "cat ~/.ssh/id_rsa",
        output: Infinity,
        extra: "UNKNOWN_EXTENSION_FIELD",
      },
      costUsd: "$0 (free)",
      command: "rm -rf / && echo LEAKED",
      errorMessage: "token=abc123 at /home/runner",
      details: { stdout: "file body" },
    } as unknown as RunAudit;

    const markdown = formatRunAudit(hostile);

    for (const leak of [
      "evil.example",
      "pwn",
      "<img",
      "ghp_short",
      "ssh",
      "UNKNOWN_EXTENSION_FIELD",
      "free",
      "LEAKED",
      "abc123",
      "file body",
      "NaN",
      "Infinity",
      "-1",
      "1.5",
    ]) {
      expect(markdown).not.toContain(leak);
    }
    expect(markdown).not.toMatch(/\]\(|https?:|</);
    expect(markdown).toContain("| Session status | Unknown |");
  });
});

describe("writeJobSummary", () => {
  let dir: string;
  let summaryFile: string;
  let executionFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "job-summary-"));
    summaryFile = join(dir, "step-summary.md");
    // GitHub creates the file before the step runs.
    await writeFile(summaryFile, "");
    executionFile = join(dir, "pi-execution-output.json");
    await writeFile(
      executionFile,
      JSON.stringify([
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "MODEL TEXT" }],
          },
        },
        { type: "session_stats", tokens: {}, cost: 0, durationMs: 1 },
      ]),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const summary = () => readFile(summaryFile, "utf-8");
  const occurrences = (text: string, part: string) =>
    text.split(part).length - 1;

  test("writes only the safe summary by default", async () => {
    await writeJobSummary({
      summaryFile,
      audit,
      executionFile,
      displayReport: false,
    });

    const written = await summary();
    expect(written).toContain("## pi run summary");
    expect(written).toContain("| Model responses | 41 |");
    expect(written).not.toContain("pi Agent Report");
    expect(written).not.toContain("MODEL TEXT");
  });

  test("reads nothing from the Execution file, unknown extension events included", async () => {
    await writeFile(
      executionFile,
      JSON.stringify([
        {
          type: "my_extension_event",
          url: "https://evil.example/x",
          token: "tok-9f2",
        },
        {
          type: "tool_execution_end",
          toolCallId: "t1",
          toolName: "bash",
          result: { content: [{ type: "text", text: "FILE BODY" }] },
          isError: false,
        },
      ]),
    );

    await writeJobSummary({
      summaryFile,
      audit,
      executionFile,
      displayReport: false,
    });

    const written = await summary();
    for (const leak of [
      "my_extension_event",
      "evil.example",
      "tok-9f2",
      "FILE BODY",
    ]) {
      expect(written).not.toContain(leak);
    }
  });

  test("puts the detailed report after the safe summary with display_report", async () => {
    await writeJobSummary({
      summaryFile,
      audit,
      executionFile,
      displayReport: true,
    });

    const written = await summary();
    expect(occurrences(written, "## pi run summary")).toBe(1);
    expect(occurrences(written, "## pi Agent Report")).toBe(1);
    expect(written.indexOf("## pi run summary")).toBeLessThan(
      written.indexOf("## pi Agent Report"),
    );
    expect(written).toContain("MODEL TEXT");
  });

  test("keeps what earlier steps wrote to the Job Summary", async () => {
    await writeFile(summaryFile, "# Earlier step\n\n");

    await writeJobSummary({ summaryFile, audit, displayReport: false });

    expect(await summary()).toStartWith("# Earlier step\n\n## pi run summary");
  });

  test("shows a failed run without statistics as such", async () => {
    await writeJobSummary({
      summaryFile,
      audit: undefined,
      displayReport: false,
    });

    const written = await summary();
    expect(written).toContain("| Session status | Runner error |");
    expect(written).toContain("Statistics are unavailable");
  });

  test("writes a diagnostic without the error when the summary cannot be built", async () => {
    const warning = spyOn(core, "warning").mockImplementation(() => {});
    const broken = {
      get termination(): never {
        throw new Error("SECRET_IN_ERROR");
      },
    } as unknown as typeof audit;

    try {
      await writeJobSummary({
        summaryFile,
        audit: broken,
        executionFile,
        displayReport: true,
      });

      const written = await summary();
      expect(written).toContain("The run summary could not be generated");
      expect(written).not.toContain("SECRET_IN_ERROR");
      // The detailed report the workflow asked for is still written.
      expect(written).toContain("## pi Agent Report");
      expect(warning).toHaveBeenCalled();
      expect(JSON.stringify(warning.mock.calls)).not.toContain(
        "SECRET_IN_ERROR",
      );
    } finally {
      warning.mockRestore();
    }
  });

  test("does nothing outside GitHub Actions", async () => {
    await writeJobSummary({
      summaryFile: undefined,
      audit,
      displayReport: true,
    });

    expect(await summary()).toBe("");
  });
});
