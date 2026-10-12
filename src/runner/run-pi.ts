import * as core from "@actions/core";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "../github/utils/sanitizer";
import { createModelRuntime, type ModelRuntimeOptions } from "./model-runtime";
import { isolatedBashTool } from "./bash-isolation";
import { commentRedactionExtension } from "./comment-redaction";
import { parsePiArgs } from "./pi-args";
import { expandSlashCommand } from "./slash-command";
import {
  writeExecutionFile,
  type ExecutionRecord,
  type SessionStatsRecord,
} from "./execution-file";
import { mcpServerExtensions, type McpServers } from "./mcp-servers";
import {
  toolPermissionsExtension,
  type ToolPermissions,
} from "./tool-permissions";
import type { ToolRule } from "./tool-rules";
import {
  createStructuredOutput,
  type StructuredOutput,
} from "./structured-output";

export type RunnerOptions = ModelRuntimeOptions & {
  /** Model in pi's `provider/id[:thinking]` form. Required. */
  model?: string;
  /**
   * The api_key input: a key for the model's provider, used instead of the
   * provider's environment variable. Like pi's --api-key, it is not stored.
   */
  apiKey?: string;
  /**
   * Tag mode: the trigger comment's request without the trigger phrase, e.g.
   * "/skill:review-pr focus on auth". A slash command in it is expanded and
   * appended to the prompt.
   */
  userRequest?: string;
  /** The pi_args input: pi's own command-line flags, a supported subset. */
  piArgs?: string;
  /**
   * The allowed_tools input, plus the mode's own rules. Calls to tools other
   * than the read-only ones must match a rule.
   */
  allowedTools?: ToolRule[];
  /** The disallowed_tools input: rules that block calls, before allowed_tools. */
  disallowedTools?: ToolRule[];
  /**
   * Directory of the skills the skills input installed. Loaded like a
   * `--skill` path in pi, so `--no-skills` in pi_args does not drop them.
   */
  skillsDir?: string;
  /**
   * Let edit and write change files in the working directory without a rule,
   * like Claude Code's acceptEdits permission mode in Upstream's tag mode.
   */
  acceptEdits?: boolean;
  /**
   * Let bash run `git status`, `git diff`, `git log` and `git show` without a
   * rule, like Claude Code's read-only commands in Upstream's tag mode.
   */
  readOnlyGit?: boolean;
  /**
   * The json_schema input: a JSON Schema for an object. When set, the model
   * submits its result with the submit_result tool, and the run fails if it
   * does not.
   */
  jsonSchema?: string;
  /**
   * Isolate the bash tool, for untrusted input (allowed_non_write_users): its
   * commands get only allowlisted variables and run in bwrap where it works.
   */
  isolateBash?: boolean;
  /** The allowed_bash_env input: more variables the isolated bash keeps. */
  allowedBashEnv?: string;
  /**
   * bwrap for the isolated bash. Defaults to bwrap on PATH; tests point it at
   * a missing file to exercise the fallback.
   */
  bwrapPath?: string;
  /**
   * The show_full_output input, or a debug rerun: log every event recorded in
   * the Execution file, redacted. Off by default, since the job log is public
   * on public repositories.
   */
  showFullOutput?: boolean;
  /** The action's MCP servers, registered with `direct` exposure. */
  mcpServers?: McpServers;
  /** Working directory of the session. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Model runtime to use. Defaults to one that reads provider keys from the
   * environment and keeps every credential in memory. Tests pass a runtime
   * with pi's faux provider registered.
   */
  modelRuntime?: ModelRuntime;
};

export type RunnerResult = {
  /**
   * Always "success": a failed run throws instead. Kept so run.ts reads the
   * result as Upstream's does.
   */
  conclusion: "success";
  executionFile?: string;
  sessionId?: string;
  structuredOutput?: string;
};

// Streaming deltas: message_end and tool_execution_end carry the final values.
const OMITTED_EVENTS = new Set<AgentSessionEvent["type"]>([
  "message_update",
  "tool_execution_update",
]);

/**
 * pi's codemode tool. Its extension is always loaded but, as in pi, the tool
 * is off until `--tools +codemode` in pi_args turns it on. Running a script
 * then needs no rule; disallowed_tools can still block it. The tools a script
 * calls go through tool_call, so the tool permissions extension checks them
 * like direct calls.
 */
const CODEMODE_RULE: ToolRule = { text: "codemode", tool: "codemode" };

/**
 * Variables the agent must not see, removed as Upstream removes them from the
 * Claude Code environment. With the OIDC request pair the agent could mint new
 * tokens; ALL_INPUTS holds the serialized workflow inputs and is only needed
 * to detect which inputs were set, before the Runner starts.
 *
 * pi runs in this process (ADR-0001), so its tools and MCP servers inherit
 * process.env: the variables are deleted from it, not just from a child env.
 */
const AGENT_HIDDEN_ENV = [
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ALL_INPUTS",
];

/**
 * Run one pi session on the prompt, in this process (ADR-0001).
 *
 * The Execution file is written whether the session succeeds or fails. A
 * failed session throws after the file is written, like Upstream's executor.
 */
export async function runPi(
  prompt: string,
  options: RunnerOptions,
): Promise<RunnerResult> {
  if (!prompt) {
    throw new Error("The prompt is empty. Please provide a non-empty prompt.");
  }
  const modelReference = options.model?.trim();
  if (!modelReference) {
    // pi would otherwise pick a model on its own; CI must not depend on that.
    throw new Error(
      "The model input is required. Set it to a pi model in provider/id form, for example opencode/gpt-6-luna.",
    );
  }

  const piArgs = parsePiArgs(options.piArgs);
  const cwd = options.cwd ?? process.cwd();
  const structuredOutput = createStructuredOutput(options.jsonSchema);
  const toolPermissions = buildToolPermissions(options, cwd, structuredOutput);
  const customTools = bashTools(options, cwd);

  for (const name of AGENT_HIDDEN_ENV) {
    delete process.env[name];
  }

  const modelRuntime =
    options.modelRuntime ?? (await createModelRuntime(options));
  const model = await resolveModel(
    modelRuntime,
    modelReference,
    options.apiKey,
  );

  // pi's global directory. Settings live in memory and sessions are not
  // persisted, so this stays empty; it only keeps pi away from ~/.pi/agent.
  const agentDir = await mkdtemp(
    join(process.env.RUNNER_TEMP || tmpdir(), "pi-agent-"),
  );
  // Settings live only in memory: neither ~/.pi/agent/settings.json nor the
  // repository's .pi/settings.json is read, and nothing is written, so the
  // agent cannot change configuration later processes in the job would read
  // (docs/development/upstream-divergence.md). Pass every setting here at
  // once: values applied afterwards with applyOverrides() are lost on reload
  // (test/pi-sdk/settings.test.ts).
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      toolPermissionsExtension(toolPermissions),
      createCodemodeExtension(),
      commentRedactionExtension(),
      ...(structuredOutput ? [structuredOutput.extension] : []),
      ...mcpServerExtensions(
        options.mcpServers ?? {},
        join(agentDir, "mcp.log"),
      ),
    ],
    additionalSkillPaths: options.skillsDir ? [options.skillsDir] : [],
    ...piArgs.resources,
  });
  await resourceLoader.reload();
  const command = expandRequestedCommand(options.userRequest, resourceLoader);

  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: model.model,
    // --thinking wins over a :<thinking> suffix on the model, as in pi's CLI.
    thinkingLevel: piArgs.thinkingLevel ?? model.thinkingLevel,
    tools: structuredOutput
      ? structuredOutput.sessionTools(piArgs)
      : piArgs.tools,
    excludeTools: piArgs.excludeTools,
    noTools: piArgs.noTools,
    customTools,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager,
  });
  const toolsProblem = structuredOutput?.toolsProblem(
    session.getActiveToolNames(),
  );
  if (toolsProblem) {
    await closeSession(session);
    throw new Error(toolsProblem);
  }

  const records = recordEvents(
    session,
    sessionManager.getHeader(),
    options.showFullOutput,
  );
  const { failure, stats } = await runSession(
    session,
    command ? `${prompt}\n\n${command}` : prompt,
    structuredOutput,
  );
  const totals: SessionStatsRecord = { type: "session_stats", ...stats };
  records.push(totals);
  core.info(
    `pi used ${stats.tokens.total} tokens in ${stats.assistantMessages} responses, cost $${stats.cost.toFixed(4)}`,
  );

  const executionFile = await writeExecutionFile(records);
  const sessionId = session.sessionId;
  core.info(`Set session_id: ${sessionId}`);

  if (failure !== undefined) {
    throw new Error(`pi execution failed: ${failure}`);
  }
  return {
    conclusion: "success",
    executionFile,
    sessionId,
    structuredOutput: structuredOutput?.output(),
  };
}

/** The allowed_tools and disallowed_tools rules, and what the run allows besides. */
function buildToolPermissions(
  options: RunnerOptions,
  cwd: string,
  structuredOutput: StructuredOutput | undefined,
): ToolPermissions {
  const allowed = [...(options.allowedTools ?? []), CODEMODE_RULE];
  return {
    allowed: structuredOutput
      ? [...allowed, structuredOutput.allowRule]
      : allowed,
    disallowed: options.disallowedTools ?? [],
    editableWorkspace: options.acceptEdits ? cwd : undefined,
    readOnlyGit: options.readOnlyGit,
    procHiddenFrom: options.isolateBash ? cwd : undefined,
  };
}

/** The isolated bash tool that replaces the built-in one, when bash is isolated. */
function bashTools(options: RunnerOptions, cwd: string): ToolDefinition[] {
  if (options.isolateBash) {
    return [
      isolatedBashTool(cwd, {
        allowedEnv: options.allowedBashEnv,
        bwrapPath: options.bwrapPath,
      }),
    ];
  }
  if (options.allowedBashEnv?.trim()) {
    core.warning(
      "allowed_bash_env has no effect: bash is only isolated when allowed_non_write_users is set and subprocess_isolation is not false.",
    );
  }
  return [];
}

/** Resolve the model input, and give its provider the api_key input if set. */
async function resolveModel(
  modelRuntime: ModelRuntime,
  reference: string,
  apiKey: string | undefined,
) {
  const resolved = resolveCliModel({ cliModel: reference, modelRuntime });
  if (!resolved.model) {
    throw new Error(`Cannot use model '${reference}': ${resolved.error}`);
  }
  if (apiKey) {
    await modelRuntime.setRuntimeApiKey(resolved.model.provider, apiKey);
  }
  return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
}

/**
 * Collect the session's events for the Execution file, starting with the
 * session header, and log them when showFullOutput is set.
 */
function recordEvents(
  session: AgentSession,
  header: ExecutionRecord | null,
  showFullOutput: boolean | undefined,
): ExecutionRecord[] {
  const records: ExecutionRecord[] = header ? [header] : [];
  session.subscribe((event) => {
    if (OMITTED_EVENTS.has(event.type)) return;
    records.push(event);
    if (showFullOutput) {
      core.info(redactSecrets(JSON.stringify(event, null, 2)));
    }
  });
  if (!showFullOutput) {
    core.info(
      "Running pi (full output hidden for security). Rerun in debug mode or set show_full_output: true for every event in the log.",
    );
  }
  return records;
}

/**
 * Prompt the session and dispose of it. Returns why the run failed, if it did,
 * and the totals for the whole run, so spend can be tracked per run.
 */
async function runSession(
  session: AgentSession,
  prompt: string,
  structuredOutput: StructuredOutput | undefined,
) {
  let failure: string | undefined;
  const startedAt = Date.now();
  try {
    await session.bindExtensions({});
    await session.prompt(prompt);
    failure = sessionFailure(session.messages) ?? structuredOutput?.failure();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const {
    sessionFile: _file,
    contextUsage: _context,
    ...totals
  } = session.getSessionStats();
  await closeSession(session);
  return { failure, stats: { ...totals, durationMs: Date.now() - startedAt } };
}

/**
 * Shut the session's extensions down, then dispose of the session. dispose()
 * alone does not emit session_shutdown, so the MCP servers' processes would
 * keep running and the action would not exit until the job timed out.
 */
async function closeSession(session: AgentSession) {
  const runner = session.extensionRunner;
  if (runner.hasHandlers("session_shutdown")) {
    await runner.emit({ type: "session_shutdown", reason: "quit" });
  }
  session.dispose();
}

/**
 * Why the session failed, or undefined if it succeeded. pi reports a provider
 * error, after its own retries, as the stop reason of the final assistant
 * message rather than by rejecting prompt().
 */
function sessionFailure(
  messages: AgentSession["messages"],
): string | undefined {
  const last = messages.findLast((m) => m.role === "assistant");
  if (!last) return "the model did not respond";
  if (last.stopReason === "error" || last.stopReason === "aborted") {
    return last.errorMessage ?? `the model stopped with ${last.stopReason}`;
  }
  return undefined;
}

/**
 * The expansion of a slash command in the trigger comment (/skill:<name> or
 * /<template>). Undefined when there is no request, or it is not a known
 * command.
 */
function expandRequestedCommand(
  request: string | undefined,
  sources: Parameters<typeof expandSlashCommand>[1],
): string | undefined {
  if (!request) return undefined;
  const expanded = expandSlashCommand(request, sources);
  if (expanded) {
    core.info(`Expanded ${request.trim().split(/\s/)[0]} from the request`);
  }
  return expanded;
}
