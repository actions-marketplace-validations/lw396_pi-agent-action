import { checkHumanActor } from "../../github/validation/actor";
import { createInitialComment } from "../../github/operations/comments/create-initial";
import { setupBranch } from "../../github/operations/branch";
import { setupGitAuth } from "../git-auth";
import { prepareMcpConfig } from "../../mcp/install-mcp-server";
import {
  fetchGitHubData,
  hashChangedFiles,
  resolveTriggerTimestamp,
  extractOriginalTitle,
  extractOriginalBody,
} from "../../github/data/fetcher";
import { createPrompt } from "../../create-prompt";
import { isEntityContext } from "../../github/context";
import type { PrepareOptions, PrepareResult } from "../types";

/**
 * Prepares the tag mode execution context.
 *
 * Tag mode responds to @pi mentions, issue assignments, or labels.
 * Creates tracking comments showing progress and has full implementation capabilities.
 */
export async function prepareTagMode({
  context,
  octokit,
  githubToken,
  githubTokenSource,
  allowedTools: workflowAllowedTools,
  untrustedInput,
}: PrepareOptions): Promise<PrepareResult> {
  // Tag mode only handles entity-based events
  if (!isEntityContext(context)) {
    throw new Error("Tag mode requires entity context");
  }

  // Check if actor is human
  await checkHumanActor(octokit.rest, context);

  // Create initial tracking comment
  const commentData = await createInitialComment(octokit.rest, context);
  const commentId = commentData.id;

  const triggerTime = await resolveTriggerTimestamp(context, octokit);
  const originalTitle = extractOriginalTitle(context);
  const originalBody = extractOriginalBody(context);

  const fetchedData = await fetchGitHubData({
    octokits: octokit,
    repository: `${context.repository.owner}/${context.repository.repo}`,
    prNumber: context.entityNumber.toString(),
    isPR: context.isPR,
    triggerUsername: context.actor,
    triggerTime,
    originalTitle,
    originalBody,
    includeCommentsByActor: context.inputs.includeCommentsByActor,
    excludeCommentsByActor: context.inputs.excludeCommentsByActor,
  });

  const commitMethod = await setupGitAuth({
    githubToken,
    context,
    untrustedInput,
    failOnError: true,
  });

  const branchInfo = await setupBranch(octokit, fetchedData, context);

  // Hash the PR's changed files now that its branch is checked out.
  const githubData = {
    ...fetchedData,
    changedFilesWithSHA: hashChangedFiles(fetchedData.changedFiles),
  };

  const { prompt, userRequest } = createPrompt(
    commentId,
    branchInfo.baseBranch,
    branchInfo.agentBranch,
    githubData,
    context,
    githubTokenSource,
  );

  const gitPushWrapper = `${process.env.GITHUB_ACTION_PATH}/scripts/git-push.sh`;

  // Rules tag mode adds to the allowed_tools input.
  // Edit/MultiEdit/Write are intentionally omitted: acceptEdits (returned below)
  // lets the Runner allow file edits inside $GITHUB_WORKSPACE and block writes
  // outside (e.g. ~/.bashrc). Listing them here would grant blanket write
  // access to the whole runner (Asana 1213310082312048).
  const tagModeTools = [
    "Glob",
    "Grep",
    "LS",
    "Read",
    "mcp__github_comment__update_comment",
    "mcp__github_ci__get_ci_status",
    "mcp__github_ci__get_workflow_run_details",
    "mcp__github_ci__download_job_log",
  ];

  // Add git commands when using git CLI (no API commit signing, or SSH signing)
  // SSH signing still uses git CLI, just with signing enabled
  if (commitMethod !== "api") {
    tagModeTools.push(
      "Bash(git add:*)",
      "Bash(git commit:*)",
      `Bash(${gitPushWrapper}:*)`,
      "Bash(git rm:*)",
    );
  } else {
    // When using API commit signing, use MCP file ops tools
    tagModeTools.push(
      "mcp__github_file_ops__commit_files",
      "mcp__github_file_ops__delete_files",
    );
  }
  const allowedTools = Array.from(new Set(tagModeTools));

  // The action's MCP servers the run needs: tag mode's tools, and the
  // workflow's (the inline comment server, for example).
  const mcpServers = await prepareMcpConfig({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    branch: branchInfo.agentBranch || branchInfo.currentBranch,
    baseBranch: branchInfo.baseBranch,
    trackingCommentId: commentId.toString(),
    allowedTools: [
      ...allowedTools,
      ...workflowAllowedTools.map((rule) => rule.tool),
    ],
    mode: "tag",
    context,
  });

  return {
    prompt,
    userRequest,
    commentId,
    branchInfo,
    mcpServers,
    allowedTools,
    acceptEdits: true,
    readOnlyGit: true,
  };
}
