import * as core from "@actions/core";
import { GITHUB_API_URL, GITHUB_SERVER_URL } from "../github/api/config";
import type { GitHubContext } from "../github/context";
import { isEntityContext } from "../github/context";
import { redactSecrets } from "../github/utils/sanitizer";
import { Octokit } from "@octokit/rest";
import type { AutoDetectedMode } from "../modes/detector";
import type { McpServers } from "../runner/mcp-servers";
import type { TokenBrokerAddress } from "../github/token-broker";
import { inlineCommentBufferPath } from "./inline-comment-buffer";

type PrepareConfigParams = {
  githubToken: string;
  /**
   * Where the servers get the current app token instead of githubToken, so
   * they keep working after it is refreshed (src/github/token-refresh.ts).
   */
  tokenBroker?: TokenBrokerAddress;
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  trackingCommentId?: string;
  allowedTools: string[];
  mode: AutoDetectedMode;
  context: GitHubContext;
};

// Build the bun invocation for one of the action's own MCP servers. The
// flags mirror the entrypoint invocation in action.yml so the server process
// reads its runtime config from the action directory rather than from the
// process working directory.
function bunServerArgs(scriptPath: string): string[] {
  const actionPath = process.env.GITHUB_ACTION_PATH;
  return [
    "--no-env-file",
    `--config=${actionPath}/bunfig.toml`,
    "run",
    `${actionPath}/${scriptPath}`,
  ];
}

async function checkActionsReadPermission(
  token: string,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    const client = new Octokit({ auth: token, baseUrl: GITHUB_API_URL });

    // Try to list workflow runs - this requires actions:read
    // We use per_page=1 to minimize the response size
    await client.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      per_page: 1,
    });

    return true;
  } catch (error: any) {
    // Check if it's a permission error
    if (
      error.status === 403 &&
      error.message?.includes("Resource not accessible")
    ) {
      return false;
    }

    // For other errors (network issues, etc), log but don't fail
    core.debug(`Failed to check actions permission: ${error.message}`);
    return false;
  }
}

/**
 * The env that gives a server the GitHub token: the broker's address when
 * there is one, so the token itself is not in the server's env.
 */
function githubTokenEnv(
  githubToken: string,
  tokenBroker: TokenBrokerAddress | undefined,
): Record<string, string> {
  return tokenBroker
    ? {
        GITHUB_TOKEN_BROKER_URL: tokenBroker.url,
        GITHUB_TOKEN_BROKER_KEY: tokenBroker.key,
      }
    : { GITHUB_TOKEN: githubToken };
}

/** The action's own MCP servers, by name, that the run needs. */
export async function prepareMcpConfig(
  params: PrepareConfigParams,
): Promise<McpServers> {
  const {
    githubToken,
    tokenBroker,
    owner,
    repo,
    branch,
    baseBranch,
    trackingCommentId,
    allowedTools,
    context,
    mode,
  } = params;
  try {
    const allowedToolsList = allowedTools || [];

    // Detect if we're in agent mode (explicit prompt provided)
    const isAgentMode = mode === "agent";

    const hasGitHubCommentTools = allowedToolsList.some(
      (tool) =>
        tool === "mcp__github_comment" ||
        tool.startsWith("mcp__github_comment__"),
    );

    const hasGitHubMcpTools = allowedToolsList.some(
      (tool) => tool === "mcp__github" || tool.startsWith("mcp__github__"),
    );

    const hasInlineCommentTools = allowedToolsList.some(
      (tool) =>
        tool === "mcp__github_inline_comment" ||
        tool.startsWith("mcp__github_inline_comment__"),
    );

    const hasGitHubCITools = allowedToolsList.some(
      (tool) =>
        tool === "mcp__github_ci" || tool.startsWith("mcp__github_ci__"),
    );

    const servers: McpServers = {};

    // Include comment server:
    // - Always in tag mode (for updating the tracking comment)
    // - Only with explicit tools in agent mode
    const shouldIncludeCommentServer = !isAgentMode || hasGitHubCommentTools;

    if (shouldIncludeCommentServer) {
      servers.github_comment = {
        command: "bun",
        args: bunServerArgs("src/mcp/github-comment-server.ts"),
        env: {
          ...githubTokenEnv(githubToken, tokenBroker),
          REPO_OWNER: owner,
          REPO_NAME: repo,
          ...(trackingCommentId && { TRACKING_COMMENT_ID: trackingCommentId }),
          GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME || "",
          GITHUB_API_URL: GITHUB_API_URL,
        },
      };
    }

    // Include file ops server when commit signing is enabled
    if (context.inputs.useCommitSigning) {
      servers.github_file_ops = {
        command: "bun",
        args: bunServerArgs("src/mcp/github-file-ops-server.ts"),
        env: {
          ...githubTokenEnv(githubToken, tokenBroker),
          REPO_OWNER: owner,
          REPO_NAME: repo,
          BRANCH_NAME: branch,
          BASE_BRANCH: baseBranch,
          REPO_DIR: process.env.GITHUB_WORKSPACE || process.cwd(),
          GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME || "",
          IS_PR: process.env.IS_PR || "false",
          GITHUB_API_URL: GITHUB_API_URL,
        },
      };
    }

    // Include inline comment server for PRs when requested via allowed tools
    if (
      isEntityContext(context) &&
      context.isPR &&
      (hasGitHubMcpTools || hasInlineCommentTools)
    ) {
      servers.github_inline_comment = {
        command: "bun",
        args: bunServerArgs("src/mcp/github-inline-comment-server.ts"),
        env: {
          ...githubTokenEnv(githubToken, tokenBroker),
          REPO_OWNER: owner,
          REPO_NAME: repo,
          PR_NUMBER: context.entityNumber?.toString() || "",
          GITHUB_API_URL: GITHUB_API_URL,
          CLASSIFY_INLINE_COMMENTS: context.inputs.classifyInlineComments
            ? "true"
            : "false",
          // pi passes a server only the env listed here, not RUNNER_TEMP.
          INLINE_COMMENT_BUFFER: inlineCommentBufferPath(),
        },
      };
    }

    // CI server is included when:
    // - In tag mode: when we have a workflow token and context is a PR
    // - In agent mode: same conditions PLUS explicit CI tools in allowedTools
    const hasWorkflowToken = !!process.env.DEFAULT_WORKFLOW_TOKEN;
    const shouldIncludeCIServer =
      (!isAgentMode || hasGitHubCITools) &&
      isEntityContext(context) &&
      context.isPR &&
      hasWorkflowToken;

    if (shouldIncludeCIServer) {
      // Verify the token actually has actions:read permission
      const actuallyHasPermission = await checkActionsReadPermission(
        process.env.DEFAULT_WORKFLOW_TOKEN || "",
        owner,
        repo,
      );

      if (!actuallyHasPermission) {
        core.warning(
          "The github_ci MCP server requires 'actions: read' permission. " +
            "Skipping CI server installation. " +
            "To enable CI status checks, add 'actions: read' to your workflow permissions. " +
            "See: https://docs.github.com/en/actions/security-guides/automatic-token-authentication#permissions-for-the-github_token",
        );
      } else {
        servers.github_ci = {
          command: "bun",
          args: bunServerArgs("src/mcp/github-actions-server.ts"),
          env: {
            // Use workflow github token, not app token
            GITHUB_TOKEN: process.env.DEFAULT_WORKFLOW_TOKEN!,
            REPO_OWNER: owner,
            REPO_NAME: repo,
            PR_NUMBER: context.entityNumber?.toString() || "",
            RUNNER_TEMP: process.env.RUNNER_TEMP || "/tmp",
          },
        };
      }
    }

    if (hasGitHubMcpTools) {
      servers.github = {
        command: "docker",
        args: [
          "run",
          "-i",
          "--rm",
          "-e",
          "GITHUB_PERSONAL_ACCESS_TOKEN",
          "-e",
          "GITHUB_HOST",
          "ghcr.io/github/github-mcp-server:sha-23fa0dd", // https://github.com/github/github-mcp-server/releases/tag/v0.17.1
        ],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
          GITHUB_HOST: GITHUB_SERVER_URL,
        },
      };
    }

    return servers;
  } catch (error) {
    throw new Error(
      `Install MCP server failed with error: ${redactSecrets(String(error))}`,
    );
  }
}
