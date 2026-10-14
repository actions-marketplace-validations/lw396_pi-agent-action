#!/usr/bin/env bun

/**
 * Unified entrypoint for the action.
 * Merges all previously separate action.yml steps (prepare, run, cleanup)
 * into a single TypeScript orchestrator.
 */

import * as core from "@actions/core";
import { setupGitHubToken, WorkflowValidationSkipError } from "../github/token";
import { checkWritePermissions } from "../github/validation/permissions";
import { createOctokit } from "../github/api/client";
import type { Octokits } from "../github/api/client";
import {
  parseGitHubContext,
  isEntityContext,
  isPullRequestEvent,
  isPullRequestReviewEvent,
  isPullRequestReviewCommentEvent,
  isWorkflowRunEvent,
} from "../github/context";
import type { GitHubContext } from "../github/context";
import { detectMode } from "../modes/detector";
import { prepareTagMode } from "../modes/tag";
import { prepareAgentMode } from "../modes/agent";
import { checkContainsTrigger } from "../github/validation/trigger";
import { restoreConfigFromBase } from "../github/operations/restore-config";
import { validateBranchName } from "../github/operations/branch";
import { assertNoRemovedInputs } from "./removed-inputs";
import { updateCommentLink } from "./update-comment-link";
import { writeJobSummary } from "./job-summary";
import { redactSecrets } from "../github/utils/sanitizer";
import { collectSecretValues } from "../runner/secret-values";
import { runPi } from "../runner/run-pi";
import { RunnerFailure, type RunAudit } from "../runner/run-audit";
import { readRunnerInputs, runnerOptions } from "../runner/run-plan";
import { installSkills } from "../runner/skills";
import { setExecutionFileOutputIfPresent } from "../runner/execution-file";

async function run() {
  // Before anything changes the environment: every redactSecrets() call in
  // this process, the Runner's included, redacts these values.
  collectSecretValues(process.env);

  let githubToken: string | undefined;
  let commentId: number | undefined;
  let agentBranch: string | undefined;
  let baseBranch: string | undefined;
  let executionFile: string | undefined;
  // Set once runPi() is called: from then on the Job Summary gets the run
  // summary, with runAudit if the session got far enough to report one.
  let runnerStarted = false;
  let runAudit: RunAudit | undefined;
  let agentSuccess = false;
  let prepareSuccess = true;
  let prepareError: string | undefined;
  let context: GitHubContext | undefined;
  let octokit: Octokits | undefined;
  // Paths reverted to the PR base branch, which cleanup must not commit back
  // onto the PR author's branch. Empty unless restoreConfigFromBase ran.
  let restoredConfigPaths: string[] = [];
  // Track whether we've completed prepare phase, so we can attribute errors correctly
  let prepareCompleted = false;
  try {
    // Phase 1: Prepare
    assertNoRemovedInputs(process.env.ALL_INPUTS);
    // Fails on a tool rule the Runner cannot enforce, before anything is set up.
    const runnerInputs = readRunnerInputs(process.env);
    context = parseGitHubContext();
    const modeName = detectMode(context);
    console.log(
      `Auto-detected mode: ${modeName} for event: ${context.eventName}`,
    );

    try {
      githubToken = await setupGitHubToken();
    } catch (error) {
      if (error instanceof WorkflowValidationSkipError) {
        core.setOutput("skipped_due_to_workflow_validation_mismatch", "true");
        console.log("Exiting due to workflow validation skip");
        return;
      }
      throw error;
    }

    octokit = createOctokit(githubToken);

    // Set GITHUB_TOKEN and GH_TOKEN in process env for downstream usage
    process.env.GITHUB_TOKEN = githubToken;
    process.env.GH_TOKEN = githubToken;

    // Check write permissions for entity contexts, and for workflow_run
    // events, whose upstream run may have been started by an actor without
    // write access (e.g. the author of a fork pull request)
    if (isEntityContext(context) || isWorkflowRunEvent(context)) {
      const hasWritePermissions = await checkWritePermissions(
        octokit.rest,
        context,
        context.inputs.allowedNonWriteUsers,
        !!process.env.OVERRIDE_GITHUB_TOKEN,
      );
      if (!hasWritePermissions) {
        throw new Error(
          "Actor does not have write permissions to the repository",
        );
      }
    }

    // Check trigger conditions
    const containsTrigger =
      modeName === "tag"
        ? isEntityContext(context) && checkContainsTrigger(context)
        : !!context.inputs?.prompt;
    console.log(`Mode: ${modeName}`);
    console.log(`Context prompt: ${context.inputs?.prompt || "NO PROMPT"}`);
    console.log(`Trigger result: ${containsTrigger}`);

    if (!containsTrigger) {
      console.log("No trigger found, skipping remaining steps");
      core.setOutput("github_token", githubToken);
      return;
    }

    // Run prepare
    console.log(
      `Preparing with mode: ${modeName} for event: ${context.eventName}`,
    );
    const prepareOptions = {
      context,
      octokit,
      githubToken,
      githubTokenSource: process.env.OVERRIDE_GITHUB_TOKEN
        ? ("input" as const)
        : ("app" as const),
      allowedTools: runnerInputs.allowedTools,
      untrustedInput: runnerInputs.untrustedInput,
    };
    const prepareResult =
      modeName === "tag"
        ? await prepareTagMode(prepareOptions)
        : await prepareAgentMode(prepareOptions);

    commentId = prepareResult.commentId;
    agentBranch = prepareResult.branchInfo.agentBranch;
    baseBranch = prepareResult.branchInfo.baseBranch;
    // Outside the checkout, so they are never committed with the agent's changes.
    const skillsDir = await installSkills(runnerInputs.skills);
    prepareCompleted = true;

    // Phase 2: Run pi through the Runner

    // On PRs, .pi/, .claude/, AGENTS.md and the like in the checkout are
    // attacker-controlled. Restore them from the base branch before pi reads them.
    //
    // We read pull_request.base.ref from the payload directly because agent
    // mode's branchInfo.baseBranch defaults to the repo's default branch rather
    // than the PR's actual target (agent/index.ts). For issue_comment on a PR the payload
    // lacks base.ref, so we fall back to the mode-provided value — tag mode
    // fetches it from GraphQL; agent mode on issue_comment is an edge case
    // that at worst restores from the wrong trusted branch (still secure).
    if (isEntityContext(context) && context.isPR) {
      let restoreBase = baseBranch;
      if (
        isPullRequestEvent(context) ||
        isPullRequestReviewEvent(context) ||
        isPullRequestReviewCommentEvent(context)
      ) {
        restoreBase = context.payload.pull_request.base.ref;
        validateBranchName(restoreBase);
      }
      if (restoreBase) {
        restoredConfigPaths = restoreConfigFromBase(restoreBase);
      }
    }

    runnerStarted = true;
    const runResult = await runPi(prepareResult.prompt, {
      ...runnerOptions(runnerInputs, prepareResult),
      skillsDir,
    });

    agentSuccess = runResult.conclusion === "success";
    executionFile = runResult.executionFile;
    runAudit = runResult.audit;

    // Set action-level outputs
    if (runResult.executionFile) {
      core.setOutput("execution_file", runResult.executionFile);
    }
    if (runResult.sessionId) {
      core.setOutput("session_id", runResult.sessionId);
    }
    if (runResult.structuredOutput) {
      core.setOutput("structured_output", runResult.structuredOutput);
    }
    core.setOutput("conclusion", runResult.conclusion);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (error instanceof RunnerFailure) runAudit = error.audit;
    executionFile ??= setExecutionFileOutputIfPresent();
    core.setOutput("conclusion", "failure");
    // Only mark as prepare failure if we haven't completed the prepare phase
    if (!prepareCompleted) {
      prepareSuccess = false;
      prepareError = errorMessage;
    }
    core.setFailed(`Action failed with error: ${redactSecrets(errorMessage)}`);
  } finally {
    // Phase 3: Cleanup (always runs)

    // Update tracking comment
    if (
      commentId &&
      context &&
      isEntityContext(context) &&
      githubToken &&
      octokit
    ) {
      try {
        await updateCommentLink({
          commentId,
          githubToken,
          agentBranch,
          baseBranch: baseBranch || context.repository.default_branch || "main",
          triggerUsername: context.actor,
          context,
          octokit,
          agentSuccess,
          outputFile: executionFile,
          prepareSuccess,
          prepareError,
          useCommitSigning: context.inputs.useCommitSigning,
          restoredConfigPaths,
        });
      } catch (error) {
        console.error("Error updating comment with job link:", error);
      }
    }

    // The run summary is always written once the Runner started; the
    // detailed report too, unless display_report is set to false.
    if (runnerStarted || executionFile) {
      await writeJobSummary({
        summaryFile: process.env.GITHUB_STEP_SUMMARY,
        audit: runAudit,
        executionFile,
        displayReport: process.env.DISPLAY_REPORT !== "false",
      });
    }

    // Set remaining action-level outputs
    core.setOutput("branch_name", agentBranch);
    core.setOutput("github_token", githubToken);
  }
}

if (import.meta.main) {
  run();
}
