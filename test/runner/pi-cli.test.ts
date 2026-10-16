// The pi CLI the Runner puts on PATH for processes the session starts, such
// as the sub-agents pi-subagents runs as separate pi processes.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { bundledPiCli, putBundledPiOnPath } from "../../src/runner/pi-cli";
import { runPi } from "../../src/runner/run-pi";
import { fauxRuntime, useScratch } from "./harness";

const getScratch = useScratch();

const sdkVersion: string = JSON.parse(
  readFileSync(
    "node_modules/@earendil-works/pi-coding-agent/package.json",
    "utf8",
  ),
).version;

/** The `pi` a process with this PATH runs, resolved as a shell would. */
function piOnPath(path: string | undefined): string {
  const found = execFileSync("sh", ["-c", "command -v pi"], {
    encoding: "utf8",
    env: { PATH: path },
  }).trim();
  return realpathSync(found);
}

describe("bundledPiCli", () => {
  test("is the CLI of the pi SDK the Runner runs", () => {
    const cli = bundledPiCli();

    expect(cli).toEndWith(
      "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    );
    expect(existsSync(cli)).toBe(true);
  });
});

describe("putBundledPiOnPath", () => {
  test("makes pi on PATH the bundled CLI, ahead of the existing PATH", async () => {
    const env: NodeJS.ProcessEnv = {
      RUNNER_TEMP: process.env.RUNNER_TEMP,
      PATH: process.env.PATH,
    };

    const binDir = await putBundledPiOnPath(env);

    expect(env.PATH).toBe(`${binDir}${delimiter}${process.env.PATH}`);
    expect(binDir).toStartWith(process.env.RUNNER_TEMP!);
    expect(piOnPath(env.PATH)).toBe(realpathSync(bundledPiCli()));
    // Started by name, as pi-subagents starts it: its shebang picks node.
    const version = execFileSync("pi", ["--version"], {
      encoding: "utf8",
      env: { PATH: env.PATH },
    });
    expect(version).toContain(sdkVersion);
  });

  test("works when PATH is unset", async () => {
    const env: NodeJS.ProcessEnv = { RUNNER_TEMP: process.env.RUNNER_TEMP };

    const binDir = await putBundledPiOnPath(env);

    expect(env.PATH).toBe(binDir!);
    expect(existsSync(join(binDir!, "pi"))).toBe(true);
  });
});

describe("runPi", () => {
  test("runs the session with the bundled pi first on PATH", async () => {
    const { modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage("Done."),
    ]);

    const result = await runPi("Say done.", {
      model,
      cwd: getScratch().cwd,
      modelRuntime,
    });

    expect(result.conclusion).toBe("success");
    expect(piOnPath(process.env.PATH)).toBe(realpathSync(bundledPiCli()));
  });
});
