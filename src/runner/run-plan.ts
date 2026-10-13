import type { McpServers } from "./mcp-servers";
import { readBaseUrls, type ModelRuntimeOptions } from "./model-runtime";
import type { RunnerOptions } from "./run-pi";
import { parseSkills, type SkillInstall } from "./skills";
import { parsePackages } from "./packages";
import { parseToolRules, type ToolRule } from "./tool-rules";

/**
 * The action inputs the Runner uses, read once from the env vars that
 * action.yml sets from them. Nothing else reads these variables.
 */
export type RunnerInputs = Required<ModelRuntimeOptions> & {
  model?: string;
  apiKey?: string;
  piArgs?: string;
  /** The allowed_tools input, which also decides the action's MCP servers. */
  allowedTools: ToolRule[];
  disallowedTools: ToolRule[];
  jsonSchema?: string;
  /** The skills input: the `gh skill install` calls prepare makes. */
  skills: SkillInstall[];
  /** Explicit native pi package sources supplied by the workflow. */
  packages: string[];
  /**
   * allowed_non_write_users is set, so content from users without write
   * access can reach the model. Prepare then keeps the GitHub token out of
   * .git/config.
   */
  untrustedInput: boolean;
  /**
   * Untrusted input, and the workflow has not opted out with
   * subprocess_isolation: false: bash gets only allowlisted variables and a
   * sandbox, and the file tools cannot read /proc.
   */
  isolateBash: boolean;
  allowedBashEnv?: string;
  /** show_full_output, or a debug rerun, which shows everything as in Upstream. */
  showFullOutput: boolean;
};

/** What a mode adds to the run, besides the workflow's inputs. */
export type ModeRunSettings = {
  /** The tag mode trigger comment's request, for slash command expansion. */
  userRequest?: string;
  /** Rules the mode allows on top of the allowed_tools input. */
  allowedTools: string[];
  acceptEdits: boolean;
  readOnlyGit: boolean;
  /** The action's MCP servers the run needs. */
  mcpServers: McpServers;
};

/**
 * Read the Runner's inputs. Throws on a tool rule the action cannot enforce
 * as written, or an invalid skills/packages line, so the run fails before
 * anything is prepared.
 */
export function readRunnerInputs(env: NodeJS.ProcessEnv): RunnerInputs {
  const untrustedInput = !!env.ALLOWED_NON_WRITE_USERS;
  return {
    model: env.MODEL,
    apiKey: env.API_KEY,
    baseUrls: readBaseUrls(env),
    piArgs: env.PI_ARGS,
    allowedTools: parseToolRules(env.INPUT_ALLOWED_TOOLS, "allowed_tools"),
    disallowedTools: parseToolRules(
      env.INPUT_DISALLOWED_TOOLS,
      "disallowed_tools",
    ),
    jsonSchema: env.JSON_SCHEMA,
    skills: parseSkills(env.INPUT_SKILLS),
    packages: parsePackages(env.INPUT_PACKAGES),
    untrustedInput,
    isolateBash: untrustedInput && env.SUBPROCESS_ISOLATION !== "false",
    allowedBashEnv: env.ALLOWED_BASH_ENV,
    // RUNNER_DEBUG is what core.isDebug() reads.
    showFullOutput:
      env.INPUT_SHOW_FULL_OUTPUT === "true" || env.RUNNER_DEBUG === "1",
  };
}

/** The Runner's options for a run of the mode with these inputs. */
export function runnerOptions(
  inputs: RunnerInputs,
  mode: ModeRunSettings,
): RunnerOptions {
  return {
    userRequest: mode.userRequest,
    model: inputs.model,
    apiKey: inputs.apiKey,
    baseUrls: inputs.baseUrls,
    piArgs: inputs.piArgs,
    packages: inputs.packages,
    // The mode's own rules come first, then the workflow's allowed_tools.
    allowedTools: [
      ...parseToolRules(mode.allowedTools.join("\n"), "allowed_tools"),
      ...inputs.allowedTools,
    ],
    disallowedTools: inputs.disallowedTools,
    acceptEdits: mode.acceptEdits,
    readOnlyGit: mode.readOnlyGit,
    jsonSchema: inputs.jsonSchema,
    isolateBash: inputs.isolateBash,
    allowedBashEnv: inputs.allowedBashEnv,
    showFullOutput: inputs.showFullOutput,
    mcpServers: mode.mcpServers,
  };
}
