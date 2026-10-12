// The Runner's options, built from the env vars action.yml sets from the
// inputs and from what the mode adds.
import { describe, expect, test } from "bun:test";
import {
  readRunnerInputs,
  runnerOptions,
  type ModeRunSettings,
} from "../../src/runner/run-plan";

const NO_MODE_SETTINGS: ModeRunSettings = {
  allowedTools: [],
  acceptEdits: false,
  readOnlyGit: false,
  mcpServers: {},
};

describe("readRunnerInputs", () => {
  test("reads each input from its env var", () => {
    const inputs = readRunnerInputs({
      MODEL: "openai/gpt-5",
      API_KEY: "key",
      OPENAI_BASE_URL: " https://proxy.example.com/prefix/v1/ ",
      PI_ARGS: "--thinking high",
      INPUT_ALLOWED_TOOLS: "Bash(npm test)",
      INPUT_DISALLOWED_TOOLS: "Write",
      JSON_SCHEMA: '{"type":"object"}',
      INPUT_SKILLS: "github/awesome-copilot git-commit@v1.2.0",
      ALLOWED_BASH_ENV: "NPM_TOKEN",
    });

    expect(inputs).toEqual({
      model: "openai/gpt-5",
      apiKey: "key",
      openaiBaseUrl: "https://proxy.example.com/prefix/v1",
      piArgs: "--thinking high",
      allowedTools: [
        { text: "Bash(npm test)", tool: "bash", pattern: "npm test" },
      ],
      disallowedTools: [{ text: "Write", tool: "write" }],
      jsonSchema: '{"type":"object"}',
      skills: [["github/awesome-copilot", "git-commit@v1.2.0"]],
      untrustedInput: false,
      isolateBash: false,
      allowedBashEnv: "NPM_TOKEN",
      showFullOutput: false,
    });
  });

  test.each([undefined, "", "   "])(
    "ignores an empty OPENAI_BASE_URL: %p",
    (value) => {
      expect(
        readRunnerInputs({ OPENAI_BASE_URL: value }).openaiBaseUrl,
      ).toBeUndefined();
    },
  );

  test("accepts a local HTTP proxy", () => {
    expect(
      readRunnerInputs({ OPENAI_BASE_URL: "http://127.0.0.1:8317/v1" })
        .openaiBaseUrl,
    ).toBe("http://127.0.0.1:8317/v1");
  });

  test.each([
    "proxy.example.com/v1",
    "/v1",
    "file:///tmp/proxy",
    "ftp://proxy.example.com/v1",
    "https://user:secret-password@proxy.example.com/v1",
    "https://proxy.example.com/v1?key=secret-password",
    "https://proxy.example.com/v1#secret-password",
  ])("rejects an invalid OPENAI_BASE_URL without echoing it: %p", (value) => {
    try {
      readRunnerInputs({ OPENAI_BASE_URL: value });
      throw new Error("Expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("OPENAI_BASE_URL");
      expect(message).not.toContain(value);
      expect(message).not.toContain("secret-password");
    }
  });

  test("fails on a tool rule the Runner cannot enforce", () => {
    expect(() =>
      readRunnerInputs({ INPUT_DISALLOWED_TOOLS: "Edit(.env)" }),
    ).toThrow("Invalid disallowed_tools: 'Edit(.env)'");
  });

  test("fails on a skills line the action would not install as written", () => {
    expect(() =>
      readRunnerInputs({ INPUT_SKILLS: "github/awesome-copilot" }),
    ).toThrow("names no skill");
  });

  test.each([
    [{}, false],
    [{ ALLOWED_NON_WRITE_USERS: "*" }, true],
    [{ ALLOWED_NON_WRITE_USERS: "alice", SUBPROCESS_ISOLATION: "true" }, true],
    [{ ALLOWED_NON_WRITE_USERS: "*", SUBPROCESS_ISOLATION: "false" }, false],
    [{ SUBPROCESS_ISOLATION: "true" }, false],
  ])("isolates bash only for untrusted input: %p", (env, isolated) => {
    expect(readRunnerInputs(env).isolateBash).toBe(isolated);
  });

  test.each([
    [{}, false],
    [{ ALLOWED_NON_WRITE_USERS: "alice" }, true],
    // Opting out of bash isolation still keeps the token out of .git/config
    [{ ALLOWED_NON_WRITE_USERS: "*", SUBPROCESS_ISOLATION: "false" }, true],
  ])(
    "treats input as untrusted when non-write users are allowed: %p",
    (env, untrusted) => {
      expect(readRunnerInputs(env).untrustedInput).toBe(untrusted);
    },
  );

  test.each([
    [{}, false],
    [{ INPUT_SHOW_FULL_OUTPUT: "true" }, true],
    [{ INPUT_SHOW_FULL_OUTPUT: "false" }, false],
    [{ RUNNER_DEBUG: "1" }, true],
  ])(
    "shows full output with show_full_output or a debug rerun: %p",
    (env, shown) => {
      expect(readRunnerInputs(env).showFullOutput).toBe(shown);
    },
  );
});

describe("runnerOptions", () => {
  test("puts the mode's rules before the allowed_tools input", () => {
    const options = runnerOptions(
      readRunnerInputs({ INPUT_ALLOWED_TOOLS: "Bash(npm test)" }),
      { ...NO_MODE_SETTINGS, allowedTools: ["Read", "Bash(git add:*)"] },
    );

    expect(options.allowedTools!.map((rule) => rule.text)).toEqual([
      "Read",
      "Bash(git add:*)",
      "Bash(npm test)",
    ]);
  });

  test("passes the mode's settings and the action's MCP servers", () => {
    const server = { command: "bun", args: ["server.ts"] };
    const options = runnerOptions(readRunnerInputs({}), {
      userRequest: "/skill:review-pr",
      allowedTools: [],
      acceptEdits: true,
      readOnlyGit: true,
      mcpServers: { github_comment: server },
    });

    expect(options.userRequest).toBe("/skill:review-pr");
    expect(options.acceptEdits).toBe(true);
    expect(options.readOnlyGit).toBe(true);
    expect(options.mcpServers).toEqual({ github_comment: server });
  });

  test("passes the inputs through", () => {
    const options = runnerOptions(
      readRunnerInputs({
        MODEL: "openai/gpt-5",
        OPENAI_BASE_URL: "https://proxy.example.com/v1",
        ALLOWED_NON_WRITE_USERS: "*",
        INPUT_SHOW_FULL_OUTPUT: "true",
      }),
      NO_MODE_SETTINGS,
    );

    expect(options).toMatchObject({
      model: "openai/gpt-5",
      openaiBaseUrl: "https://proxy.example.com/v1",
      isolateBash: true,
      showFullOutput: true,
    });
  });
});
