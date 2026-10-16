import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { join } from "node:path";
import { prepareTagMode } from "../../src/modes/tag";
import { mockIssueCommentContext } from "../mockContext";
import * as actor from "../../src/github/validation/actor";
import * as createInitial from "../../src/github/operations/comments/create-initial";
import * as fetcher from "../../src/github/data/fetcher";
import * as branch from "../../src/github/operations/branch";
import * as createPrompt from "../../src/create-prompt";
import * as mcp from "../../src/mcp/install-mcp-server";
import * as gitConfig from "../../src/github/operations/git-config";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { runPi } from "../../src/runner/run-pi";
import { parseToolRules } from "../../src/runner/tool-rules";
import { readRunnerInputs, runnerOptions } from "../../src/runner/run-plan";
import { fauxRuntime, readExecutionFile, useScratch } from "../runner/harness";

describe("Tag Mode", () => {
  const savedActionPath = process.env.GITHUB_ACTION_PATH;
  afterEach(() => {
    if (savedActionPath === undefined) delete process.env.GITHUB_ACTION_PATH;
    else process.env.GITHUB_ACTION_PATH = savedActionPath;
  });

  test("prepareTagMode is exported as a function", () => {
    expect(typeof prepareTagMode).toBe("function");
  });

  describe("git credential configuration", () => {
    let spies: Array<{ mockRestore: () => void }>;
    let configureGitAuthSpy: any;
    let replaceCheckoutCredentialsSpy: any;
    let prepareMcpConfigSpy: any;

    beforeEach(() => {
      configureGitAuthSpy = spyOn(
        gitConfig,
        "configureGitAuth",
      ).mockImplementation(async () => {});
      replaceCheckoutCredentialsSpy = spyOn(
        gitConfig,
        "replaceCheckoutCredentials",
      ).mockImplementation(async () => {});
      spies = [
        configureGitAuthSpy,
        replaceCheckoutCredentialsSpy,
        spyOn(actor, "checkHumanActor").mockImplementation(async () => {}),
        spyOn(createInitial, "createInitialComment").mockImplementation(
          async () => ({ id: 42 }) as any,
        ),
        spyOn(fetcher, "fetchGitHubData").mockImplementation(
          async () => ({ changedFiles: [] }) as any,
        ),
        spyOn(branch, "setupBranch").mockImplementation(
          async () =>
            ({
              baseBranch: "main",
              agentBranch: "claude/test",
              currentBranch: "claude/test",
            }) as any,
        ),
        spyOn(createPrompt, "createPrompt").mockImplementation(() => ({
          prompt: "Commit the notes.",
        })),
        (prepareMcpConfigSpy = spyOn(
          mcp,
          "prepareMcpConfig",
        ).mockImplementation(async () => ({}))),
      ];
    });

    afterEach(() => {
      for (const spy of spies) {
        spy.mockRestore();
      }
    });

    test("uses full git auth on the non-signing path", async () => {
      const context = { ...mockIssueCommentContext };

      await prepareTagMode({
        context,
        octokit: {} as any,
        githubToken: "test-token",
        allowedTools: [],
        untrustedInput: false,
      });

      expect(configureGitAuthSpy).toHaveBeenCalledTimes(1);
      expect(configureGitAuthSpy).toHaveBeenCalledWith(
        "test-token",
        context,
        { login: context.inputs.botName, id: parseInt(context.inputs.botId) },
        false,
      );
      // configureGitAuth performs the credential replacement itself; the mock
      // stands in for it here, so the standalone helper is not invoked.
      expect(replaceCheckoutCredentialsSpy).not.toHaveBeenCalled();
    });

    test("passes the token source to the prompt", async () => {
      await prepareTagMode({
        context: { ...mockIssueCommentContext },
        octokit: {} as any,
        githubToken: "test-token",
        githubTokenSource: "app",
        allowedTools: [],
        untrustedInput: false,
      });

      const calls = (createPrompt.createPrompt as any).mock.calls;
      expect(calls.at(-1)?.[5]).toBe("app");
    });

    test("hashes the changed files after checking out the PR's branch", async () => {
      const calls: string[] = [];
      const setupBranchSpy = spyOn(branch, "setupBranch").mockImplementation(
        async () => {
          calls.push("setupBranch");
          return { baseBranch: "main", currentBranch: "feature" } as any;
        },
      );
      const hashSpy = spyOn(fetcher, "hashChangedFiles").mockImplementation(
        () => {
          calls.push("hashChangedFiles");
          return [];
        },
      );
      try {
        await prepareTagMode({
          context: { ...mockIssueCommentContext },
          octokit: {} as any,
          githubToken: "test-token",
          allowedTools: [],
          untrustedInput: false,
        });
      } finally {
        setupBranchSpy.mockRestore();
        hashSpy.mockRestore();
      }

      expect(calls).toEqual(["setupBranch", "hashChangedFiles"]);
    });

    // With actions/checkout's persist-credentials: false, the branch setup's
    // git fetch of a private repository has only the action's token.
    test("configures git auth before setting up the branch", async () => {
      const calls: string[] = [];
      configureGitAuthSpy.mockImplementation(async () => {
        calls.push("configureGitAuth");
      });
      const setupBranchSpy = spyOn(branch, "setupBranch").mockImplementation(
        async () => {
          calls.push("setupBranch");
          return { baseBranch: "main", currentBranch: "feature" } as any;
        },
      );
      try {
        await prepareTagMode({
          context: { ...mockIssueCommentContext },
          octokit: {} as any,
          githubToken: "test-token",
          allowedTools: [],
          untrustedInput: false,
        });
      } finally {
        setupBranchSpy.mockRestore();
      }

      expect(calls).toEqual(["configureGitAuth", "setupBranch"]);
    });

    test("still replaces the checkout credential when API commit signing is enabled", async () => {
      const context = {
        ...mockIssueCommentContext,
        inputs: { ...mockIssueCommentContext.inputs, useCommitSigning: true },
      };

      await prepareTagMode({
        context,
        octokit: {} as any,
        githubToken: "test-token",
        allowedTools: [],
        untrustedInput: false,
      });

      expect(configureGitAuthSpy).not.toHaveBeenCalled();
      expect(replaceCheckoutCredentialsSpy).toHaveBeenCalledTimes(1);
      expect(replaceCheckoutCredentialsSpy).toHaveBeenCalledWith(
        "test-token",
        context,
        false,
      );
    });
    test("allows the git commands it needs, and file edits in the workspace", async () => {
      process.env.GITHUB_ACTION_PATH = "/action";

      const result = await prepareTagMode({
        context: { ...mockIssueCommentContext },
        octokit: {} as any,
        githubToken: "test-token",
        allowedTools: [],
        untrustedInput: false,
      });

      expect(result.allowedTools).toEqual(
        expect.arrayContaining([
          "Read",
          "mcp__github_comment__update_comment",
          "Bash(git add:*)",
          "Bash(git commit:*)",
          "Bash(/action/scripts/git-push.sh:*)",
          "Bash(git rm:*)",
        ]),
      );
      for (const blanket of ["Bash", "Edit", "Write", "MultiEdit"]) {
        expect(result.allowedTools).not.toContain(blanket);
      }
      expect(result.acceptEdits).toBe(true);
      expect(result.readOnlyGit).toBe(true);
    });

    test("commits through the file ops tools, without bash, under API commit signing", async () => {
      const result = await prepareTagMode({
        context: {
          ...mockIssueCommentContext,
          inputs: { ...mockIssueCommentContext.inputs, useCommitSigning: true },
        },
        octokit: {} as any,
        githubToken: "test-token",
        allowedTools: [],
        untrustedInput: false,
      });

      expect(result.allowedTools).toEqual(
        expect.arrayContaining([
          "mcp__github_file_ops__commit_files",
          "mcp__github_file_ops__delete_files",
        ]),
      );
      expect(result.allowedTools.some((t) => t.startsWith("Bash"))).toBe(false);
    });

    test("starts the MCP servers for the action's tools that allowed_tools names", async () => {
      await prepareTagMode({
        context: { ...mockIssueCommentContext },
        octokit: {} as any,
        githubToken: "test-token",
        allowedTools: parseToolRules(
          "Bash(npm test), mcp__github_inline_comment__create_inline_comment",
          "allowed_tools",
        ),
        untrustedInput: false,
      });

      const { allowedTools } = prepareMcpConfigSpy.mock.calls[0][0];
      expect(allowedTools).toContain(
        "mcp__github_inline_comment__create_inline_comment",
      );
      expect(allowedTools).not.toContain("Bash(npm test)");
    });
  });

  describe("default git command allowlist, enforced by the Runner", () => {
    const getScratch = useScratch();

    test("runs git add, commit and read-only git commands, and blocks every other command", async () => {
      const { cwd } = getScratch();
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", ...args], { cwd }).exitCode;
      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "test");
      await Bun.write(join(cwd, "notes.txt"), "notes");

      // One response per step: calls in one response run in parallel.
      const steps = [
        ["git add notes.txt"],
        [
          "git commit -q -m 'Add notes'",
          "git status",
          "touch pwned",
          "git add . && touch pwned",
        ],
      ];
      const { modelRuntime, model } = await fauxRuntime([
        ...steps.map((commands) =>
          fauxAssistantMessage(
            commands.map((command) => fauxToolCall("bash", { command })),
            { stopReason: "toolUse" },
          ),
        ),
        fauxAssistantMessage("Done."),
      ]);
      process.env.GITHUB_ACTION_PATH = "/action";
      const spies = [
        spyOn(actor, "checkHumanActor").mockImplementation(async () => {}),
        spyOn(createInitial, "createInitialComment").mockImplementation(
          async () => ({ id: 42 }) as any,
        ),
        spyOn(fetcher, "fetchGitHubData").mockImplementation(
          async () => ({ changedFiles: [] }) as any,
        ),
        spyOn(branch, "setupBranch").mockImplementation(
          async () => ({ baseBranch: "main" }) as any,
        ),
        spyOn(createPrompt, "createPrompt").mockImplementation(() => ({
          prompt: "Commit the notes.",
        })),
        spyOn(mcp, "prepareMcpConfig").mockImplementation(async () => ({})),
        spyOn(gitConfig, "configureGitAuth").mockImplementation(async () => {}),
      ];
      let prepared;
      try {
        prepared = await prepareTagMode({
          context: { ...mockIssueCommentContext },
          octokit: {} as any,
          githubToken: "test-token",
          allowedTools: [],
          untrustedInput: false,
        });
      } finally {
        for (const spy of spies) spy.mockRestore();
      }

      const result = await runPi(prepared.prompt, {
        ...runnerOptions(readRunnerInputs({}), prepared),
        model,
        cwd,
        modelRuntime,
      });

      // Calls run in parallel: match each result to its command.
      const records = readExecutionFile(result.executionFile!);
      const ran = Object.fromEntries(
        records
          .filter((r) => r.type === "tool_execution_end")
          .map((end) => {
            const start = records.find(
              (r) =>
                r.type === "tool_execution_start" &&
                r.toolCallId === end.toolCallId,
            );
            return [start!.args.command, !end.isError];
          }),
      );
      expect(ran).toEqual({
        "git add notes.txt": true,
        "git commit -q -m 'Add notes'": true,
        "git status": true,
        "touch pwned": false,
        "git add . && touch pwned": false,
      });
      expect(
        Bun.spawnSync(["git", "log", "--oneline"], { cwd }).stdout.toString(),
      ).toContain("Add notes");
      expect(await Bun.file(join(cwd, "pwned")).exists()).toBe(false);
    });
  });
});
