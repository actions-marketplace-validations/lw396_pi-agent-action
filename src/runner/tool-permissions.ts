import type {
  ExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  commandMatchesPattern,
  ruleNamesTool,
  type ToolRule,
} from "./tool-rules";
import { findShellSyntax } from "./shell-syntax";
import { checkWorkspacePath, reachesProc } from "./workspace-path";
import { isReadOnlyGitCommand } from "./read-only-git";

/**
 * pi's read-only built-in tools. Like Claude Code's read-only tools, they need
 * no rule in allowed_tools; a disallowed_tools rule still blocks them.
 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** pi's file editing tools, which take the file in their `path` argument. */
const EDIT_TOOLS = new Set(["edit", "write"]);

/** Tools that search the directories under their `path` argument. */
const SEARCH_TOOLS = new Set(["grep"]);

export type ToolPermissions = {
  allowed: ToolRule[];
  disallowed: ToolRule[];
  /**
   * Tag mode's counterpart of Claude Code's acceptEdits permission mode:
   * edits inside this directory need no rule. Unset in agent mode.
   */
  editableWorkspace?: string;
  /**
   * Tag mode: allow `git status`, `git diff`, `git log` and `git show`
   * without a rule, as Claude Code's read-only commands are in Upstream.
   */
  readOnlyGit?: boolean;
  /**
   * Keep the file tools out of /proc, relative to this working directory.
   * Set when bash is isolated: the file tools run in the pi process, outside
   * the sandbox, and /proc holds its environment.
   */
  procHiddenFrom?: string;
};

function blocked(reason: string): ToolCallEventResult {
  return { block: true, reason: `${reason} Do not retry this call.` };
}

/** Block a command whose shell syntax keeps a Bash(pattern) rule from applying. */
function blockedForShellSyntax(
  toolName: string,
  syntax: string,
  detail: string,
): ToolCallEventResult {
  return blocked(
    `This ${toolName} command uses shell syntax (${syntax}), ${detail}. Run one simple command per call, without &&, ||, ;, |, &, newlines, $(), \${}, backticks, subshells or redirections.`,
  );
}

/** Decide whether one tool call may run; undefined lets it run. */
export function checkToolCall(
  permissions: ToolPermissions,
  event: Pick<ToolCallEvent, "toolName" | "input">,
): ToolCallEventResult | undefined {
  const { toolName } = event;
  const input: Record<string, unknown> = event.input;
  const command =
    toolName === "bash" && typeof input.command === "string"
      ? input.command
      : undefined;
  // A pattern can only be checked against a single simple command.
  const shellSyntax =
    command !== undefined ? findShellSyntax(command) : undefined;
  const matches = (rule: ToolRule) =>
    rule.pattern === undefined ||
    (command !== undefined && commandMatchesPattern(command, rule.pattern));

  for (const rule of permissions.disallowed) {
    if (!ruleNamesTool(rule, toolName)) continue;
    if (rule.pattern !== undefined && shellSyntax) {
      return blockedForShellSyntax(
        toolName,
        shellSyntax,
        `so it cannot be checked against the disallowed_tools rule '${rule.text}'`,
      );
    }
    if (matches(rule)) {
      return blocked(
        `${toolName} is blocked by the disallowed_tools rule '${rule.text}'.`,
      );
    }
  }

  const procCwd = permissions.procHiddenFrom;
  if (
    procCwd !== undefined &&
    (READ_ONLY_TOOLS.has(toolName) || EDIT_TOOLS.has(toolName))
  ) {
    const path = typeof input.path === "string" ? input.path : ".";
    if (reachesProc(path, procCwd, SEARCH_TOOLS.has(toolName))) {
      return blocked(
        `${toolName} cannot access /proc, or a path that leads into it, while bash is isolated (allowed_non_write_users).`,
      );
    }
  }

  if (READ_ONLY_TOOLS.has(toolName)) return undefined;
  if (
    permissions.readOnlyGit &&
    command !== undefined &&
    isReadOnlyGitCommand(command)
  ) {
    return undefined;
  }

  const allowRules = permissions.allowed.filter((rule) =>
    ruleNamesTool(rule, toolName),
  );
  if (allowRules.some((rule) => rule.pattern === undefined)) return undefined;

  const workspace = permissions.editableWorkspace;
  if (workspace !== undefined && EDIT_TOOLS.has(toolName)) {
    const check =
      typeof input.path === "string"
        ? checkWorkspacePath(input.path, workspace)
        : ({ inside: false, reason: "outside" } as const);
    if (check.inside) return undefined;
    return blocked(
      check.reason === "git"
        ? `${toolName} cannot change files in .git without an allowed_tools rule.`
        : `${toolName} cannot change files outside the working directory (${workspace}) without an allowed_tools rule.`,
    );
  }

  if (allowRules.length === 0) {
    return blocked(
      `${toolName} is not allowed: no allowed_tools rule permits it.`,
    );
  }
  const allowed = allowRules.map((rule) => rule.text).join(", ");
  if (shellSyntax) {
    return blockedForShellSyntax(
      toolName,
      shellSyntax,
      `and allowed_tools only permits these commands: ${allowed}`,
    );
  }
  if (allowRules.some(matches)) return undefined;
  return blocked(
    `This ${toolName} command does not match any allowed_tools rule. Allowed: ${allowed}.`,
  );
}

/**
 * The tool permissions extension: enforces the allowed_tools and
 * disallowed_tools inputs on every tool call, including calls one tool makes
 * through another (pi sends those through tool_call too). A blocked call is
 * not run; the model gets the reason as the call's error result, and
 * onBlocked hears of it, for the run audit.
 */
export function toolPermissionsExtension(
  permissions: ToolPermissions,
  onBlocked?: (toolCallId: string) => void,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", (event) => {
      const result = checkToolCall(permissions, event);
      if (result?.block) onBlocked?.(event.toolCallId);
      return result;
    });
  };
}
