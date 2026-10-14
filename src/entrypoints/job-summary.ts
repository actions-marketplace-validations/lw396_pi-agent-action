import * as core from "@actions/core";
import { existsSync, readFileSync } from "fs";
import { appendFile } from "fs/promises";
import { redactSecrets } from "../github/utils/sanitizer";
import { readExecutionFile } from "../runner/execution-file";
import type { RunAudit, Termination } from "../runner/run-audit";
import { formatTurnsFromData } from "./format-turns";

/**
 * The Job Summary of a run: the safe run summary, always, then the detailed
 * pi Agent Report when display_report asks for it.
 *
 * The safe summary is built only from numbers and the labels below. Nothing
 * the model, a tool, the repository or an error message wrote reaches it, so
 * it does not depend on redaction to be safe to publish.
 */

const TERMINATION_LABELS: Record<Termination, string> = {
  completed: "Completed",
  output_limit: "Stopped at the output limit",
  model_error: "Model error",
  aborted: "Aborted",
  no_response: "No model response",
  structured_output_missing: "No structured result",
  runner_error: "Runner error",
};

const UNAVAILABLE = "unavailable";

/** Written instead of the summary when it cannot be built. */
const SUMMARY_FAILED =
  "## pi run summary\n\nThe run summary could not be generated. This does not change the run's conclusion.\n\n";

/** The safe run summary, as Markdown. Undefined: the Runner reported nothing. */
export function formatRunAudit(audit: RunAudit | undefined): string {
  const usage = audit?.usage;
  let markdown = "## pi run summary\n\n";
  markdown += "| | |\n| --- | --- |\n";
  markdown += `| Session status | ${terminationLabel(audit?.termination ?? "runner_error")} |\n`;
  markdown += `| Duration | ${duration(audit?.durationMs)} |\n`;
  markdown += `| Model responses | ${count(audit?.modelResponses)} |\n`;
  markdown += `| Tool calls attempted | ${count(audit?.toolAttempts)} |\n`;
  markdown += `| Tool calls failed | ${count(audit?.toolFailures)} |\n`;
  markdown += `| Permission denials | ${count(audit?.permissionDenials)} |\n\n`;

  markdown += "| Input tokens | Output | Cache read | Cache write | Total |\n";
  markdown += "| --- | --- | --- | --- | --- |\n";
  markdown += `| ${count(usage?.input)} | ${count(usage?.output)} | ${count(usage?.cacheRead)} | ${count(usage?.cacheWrite)} | ${count(usage?.total)} |\n\n`;

  markdown += `Estimated cost: ${cost(audit?.costUsd)}\n\n`;

  if (!audit) {
    markdown +=
      "Statistics are unavailable: the Runner stopped before the pi session could report them.\n\n";
  }
  markdown +=
    "_The session status says how the pi session ended, not whether the task was done. " +
    "Tool calls attempted include calls that were denied; failed calls are those that ran and returned an error, denials not included. " +
    "Tokens are summed over the model responses: input does not include cache reads and writes, which are counted separately, and the total is the sum of the four. pi counts cache usage a provider does not report as 0. " +
    "The cost is an estimate from the pi SDK's model catalog prices and may differ from your provider's bill, especially with a custom endpoint; it is unavailable for a model the catalog has no prices for. " +
    "The Execution file (the execution_file output) holds the full record of the session._\n\n";
  return markdown;
}

/**
 * Append the run's Job Summary to GITHUB_STEP_SUMMARY: the safe summary,
 * then the detailed report if displayReport is set. Never throws: a summary
 * that cannot be written does not change the run's conclusion.
 */
export async function writeJobSummary(options: {
  summaryFile: string | undefined;
  /** Undefined when the Runner failed before the session reported anything. */
  audit: RunAudit | undefined;
  executionFile?: string;
  displayReport: boolean;
}): Promise<void> {
  const { summaryFile, executionFile } = options;
  if (!summaryFile) return;

  let summary: string;
  try {
    summary = formatRunAudit(options.audit);
  } catch {
    core.warning("The run summary could not be generated.");
    summary = SUMMARY_FAILED;
  }
  try {
    await appendFile(summaryFile, summary);
  } catch {
    core.warning("The run summary could not be written to the Job Summary.");
  }

  if (options.displayReport && executionFile && existsSync(executionFile)) {
    await writeDetailedReport(summaryFile, executionFile);
  }
}

/** The pi Agent Report: the session's turns, from the Execution file. */
async function writeDetailedReport(
  summaryFile: string,
  executionFile: string,
): Promise<void> {
  try {
    const markdown = formatTurnsFromData(readExecutionFile(executionFile));
    await appendFile(summaryFile, markdown);
    console.log("Successfully formatted pi Agent report");
  } catch (error) {
    console.error(`Failed to format output: ${error}`);
    // Fall back to raw JSON
    try {
      let fallback = "## pi Agent Report (Raw Output)\n\n";
      fallback +=
        "Failed to format output (please report). Here's the raw JSON:\n\n";
      fallback += "```json\n";
      fallback += redactSecrets(readFileSync(executionFile, "utf-8"));
      fallback += "\n```\n";
      await appendFile(summaryFile, fallback);
    } catch {
      console.error("Failed to write raw output to step summary");
    }
  }
}

// The formatters take unknown, not RunAudit's types: they are what keeps a
// value of any other shape out of the published summary.

function terminationLabel(termination: unknown): string {
  return typeof termination === "string" &&
    Object.hasOwn(TERMINATION_LABELS, termination)
    ? TERMINATION_LABELS[termination as Termination]
    : "Unknown";
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function count(value: unknown): string {
  return isCount(value) ? value.toLocaleString("en-US") : UNAVAILABLE;
}

function duration(ms: unknown): string {
  if (!isCount(ms)) return UNAVAILABLE;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function cost(usd: unknown): string {
  return typeof usd === "number" && Number.isFinite(usd) && usd >= 0
    ? `$${usd.toFixed(4)} (estimate)`
    : UNAVAILABLE;
}
