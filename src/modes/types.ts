import type { Octokits } from "../github/api/client";
import type { GitHubContext } from "../github/context";
import type { BranchInfo } from "../github/operations/branch";
import type { GitHubTokenSource } from "../github/token";
import type { TokenBrokerAddress } from "../github/token-broker";
import type { WipTarget } from "../github/operations/wip";
import type { ModeRunSettings } from "../runner/run-plan";
import type { ToolRule } from "../runner/tool-rules";

export type PrepareOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  /** Tells the tag-mode prompt what the token can push. */
  githubTokenSource?: GitHubTokenSource;
  /** Where the action's MCP servers get the refreshed app token. */
  tokenBroker?: TokenBrokerAddress;
  /** The allowed_tools input, which decides the action's MCP servers. */
  allowedTools: ToolRule[];
  /** Content from users without write access can reach the model. */
  untrustedInput: boolean;
};

export type PrepareResult = ModeRunSettings & {
  /** The prompt the model gets. */
  prompt: string;
  /** The tracking comment, which only tag mode creates. */
  commentId?: number;
  branchInfo: BranchInfo;
  /** Where cleanup saves the agent's unfinished work if the run fails. */
  wipTarget?: WipTarget;
};
