import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { runPi } from "../../src/runner/run-pi";
import { readRunnerInputs, runnerOptions } from "../../src/runner/run-plan";
import { parseSettings, withRunSettings } from "../../src/runner/settings";
import { fauxRuntime, useScratch } from "./harness";

const scratch = useScratch();

describe("settings input", () => {
  test.each([undefined, "", "  "])("ignores empty input %p", (input) => {
    expect(parseSettings(input)).toBeUndefined();
  });

  test.each(["[]", "null", "true", "42", '"text"', '{"secret":"do-not-echo",'])(
    "rejects invalid input without echoing it: %p",
    (input) => {
      expect(() => parseSettings(input)).toThrow(/^settings must be/);
      try {
        parseSettings(input);
      } catch (error) {
        expect((error as Error).message).not.toContain("do-not-echo");
      }
    },
  );

  test.each([
    '{"__proto__":{"polluted":true}}',
    '{"plugin":{"constructor":{"prototype":{"polluted":true}}}}',
    '{"plugin":[{"prototype":{}}]}',
  ])("rejects prototype-mutating keys: %p", (input) => {
    expect(() => parseSettings(input)).toThrow("prototype-mutating keys");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("passes arbitrary plugin configuration through the input boundary", () => {
    const settings = {
      subagents: { defaultModel: "opencode-go/deepseek-v4.1-flash" },
    };
    const options = runnerOptions(
      readRunnerInputs({ INPUT_SETTINGS: JSON.stringify(settings) }),
      {
        allowedTools: [],
        acceptEdits: false,
        readOnlyGit: false,
        mcpServers: {},
      },
    );
    expect(options.settings).toEqual(settings);
  });

  test("recursively adds configuration and keeps SDK and file readers in sync", async () => {
    const agentDir = scratch().root;
    const path = join(agentDir, "settings.json");
    const base = {
      theme: "dark",
      subagents: {
        enabled: true,
        models: ["old"],
        nested: { keep: 1, replace: 1 },
      },
      retry: { enabled: false, baseDelayMs: 17 },
      keepNull: "old",
    };
    await Bun.write(path, JSON.stringify(base));
    const additions = parseSettings(
      JSON.stringify({
        subagents: {
          defaultModel: "provider/model",
          models: ["new"],
          nested: { replace: 2 },
        },
        retry: { maxRetries: 99 },
        keepNull: null,
      }),
    )!;
    await withRunSettings(agentDir, additions, 4, async (manager) => {
      const expected = {
        theme: "dark",
        subagents: {
          enabled: true,
          defaultModel: "provider/model",
          models: ["new"],
          nested: { keep: 1, replace: 2 },
        },
        retry: { enabled: false, baseDelayMs: 17, maxRetries: 4 },
        keepNull: null,
      };
      expect(manager.getSettings()).toEqual(expected);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(expected);
      await manager.reload();
      expect(manager.getSettings()).toEqual(expected);
      manager.setTheme("light");
      await manager.flush();
      expect(JSON.parse(readFileSync(path, "utf8")).theme).toBe("light");
      expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDir);
    });
    expect(base.subagents.models).toEqual(["old"]);
    expect(additions.retry).toEqual({ maxRetries: 99 });
  });

  test("restores the agent directory even when startup fails", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    await expect(
      withRunSettings(scratch().root, {}, undefined, async () => {
        throw new Error("startup failed");
      }),
    ).rejects.toThrow("startup failed");
    expect({ directory: process.env.PI_CODING_AGENT_DIR }).toEqual({
      directory: previous,
    });
  });

  test("leaves settings in memory when the input is absent", async () => {
    await withRunSettings(scratch().root, undefined, 3, async (manager) => {
      expect(manager.getRetrySettings().maxRetries).toBe(3);
    });
    expect(existsSync(join(scratch().root, "settings.json"))).toBe(false);
  });

  test("a real extension sees the merged settings through both SDK and disk", async () => {
    const cwd = scratch().cwd;
    const repoPath = join(cwd, ".pi/settings.json");
    await Bun.write(repoPath, JSON.stringify({ theme: "repo-must-not-load" }));
    const globalPath = join(process.env.HOME!, ".pi/agent/settings.json");
    await Bun.write(
      globalPath,
      JSON.stringify({ theme: "global-must-not-load" }),
    );
    await Bun.write(
      join(cwd, ".pi/extensions/settings-probe.ts"),
      `
      import { getAgentDir } from "@earendil-works/pi-coding-agent";
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      export default function (pi) {
        pi.on("session_start", (_event, ctx) => {
          const path = join(getAgentDir(), "settings.json");
          writeFileSync(join(ctx.cwd, "observed.json"), JSON.stringify({
            sdk: pi.getSettings(), disk: JSON.parse(readFileSync(path, "utf8")), path,
          }));
        });
      }
    `,
    );
    const { model, modelRuntime } = await fauxRuntime([
      fauxAssistantMessage("Done."),
    ]);
    const settings = {
      subagents: { defaultModel: "opencode-go/deepseek-v4.1-flash" },
      retry: { baseDelayMs: 7, maxRetries: 99 },
    };
    const previous = process.env.PI_CODING_AGENT_DIR;
    await runPi("Probe settings.", {
      model,
      modelRuntime,
      cwd,
      settings,
      maxRetries: 4,
    });
    const observed = JSON.parse(
      readFileSync(join(cwd, "observed.json"), "utf8"),
    );
    expect(observed.sdk).toEqual(observed.disk);
    expect(observed.sdk).toMatchObject({
      subagents: settings.subagents,
      retry: { baseDelayMs: 7, maxRetries: 4 },
    });
    expect(observed.sdk.theme).toBeUndefined();
    expect(observed.path).toStartWith(process.env.RUNNER_TEMP!);
    if (process.platform !== "win32")
      expect(statSync(observed.path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(repoPath, "utf8")).theme).toBe(
      "repo-must-not-load",
    );
    expect(JSON.parse(readFileSync(globalPath, "utf8")).theme).toBe(
      "global-must-not-load",
    );
    expect({ directory: process.env.PI_CODING_AGENT_DIR }).toEqual({
      directory: previous,
    });
  });
});
