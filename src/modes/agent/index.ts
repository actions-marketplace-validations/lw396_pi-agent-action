import { prepareMcpConfig } from "../../mcp/install-mcp-server";
import { setupGitAuth } from "../git-auth";
import { checkHumanActor } from "../../github/validation/actor";
import type { PrepareOptions, PrepareResult } from "../types";

/**
 * Prepares the agent mode execution context.
 *
 * Agent mode runs whenever an explicit prompt is provided in the workflow configuration.
 * It bypasses the standard @pi mention checking and comment tracking used by tag mode,
 * running the agent directly for automation workflows.
 */
export async function prepareAgentMode({
  context,
  octokit,
  githubToken,
  tokenBroker,
  allowedTools,
  untrustedInput,
}: PrepareOptions): Promise<PrepareResult> {
  // Check if actor is human (prevents bot-triggered loops)
  await checkHumanActor(octokit.rest, context);

  // Unlike tag mode, a run can go on without git credentials.
  await setupGitAuth({
    githubToken,
    context,
    untrustedInput,
    failOnError: false,
  });

  const prompt =
    context.inputs.prompt ||
    `Repository: ${context.repository.owner}/${context.repository.repo}`;

  // Check for branch info from environment variables (useful for auto-fix workflows)
  const agentBranch = process.env.AGENT_BRANCH || undefined;
  const defaultBranch = context.repository.default_branch || "main";
  const baseBranch = context.inputs.baseBranch || defaultBranch;

  // Detect current branch from GitHub environment
  const currentBranch =
    agentBranch ||
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    defaultBranch;

  // The allowed_tools input decides which of the action's MCP servers start
  const mcpServers = await prepareMcpConfig({
    githubToken,
    tokenBroker,
    owner: context.repository.owner,
    repo: context.repository.repo,
    branch: currentBranch,
    baseBranch: baseBranch,
    trackingCommentId: undefined, // No tracking comment in agent mode
    allowedTools: allowedTools.map((rule) => rule.tool),
    mode: "agent",
    context,
  });

  return {
    prompt,
    commentId: undefined,
    branchInfo: {
      baseBranch: baseBranch,
      currentBranch: baseBranch, // Use base branch as current when creating new branch
      agentBranch: agentBranch,
    },
    mcpServers,
    // Agent mode adds no rules of its own: allowed_tools alone decides.
    allowedTools: [],
    acceptEdits: false,
    readOnlyGit: false,
  };
}
