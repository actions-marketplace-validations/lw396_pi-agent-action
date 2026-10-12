// The custom Bun setup step is the seam: execute the actual action script
// and observe its exit status and GITHUB_PATH output, without mocking shell tools.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const metadata = readFileSync(
  new URL("../action.yml", import.meta.url),
  "utf8",
);
const block = metadata.match(
  /    - name: Setup Custom Bun Path\n[\s\S]*?      run: \|[^\n]*\n([\s\S]*?)(?=\n    - name:)/,
);
if (!block) throw new Error("Custom Bun setup step is missing");
const script = block[1]!.replace(/^ {8}/gm, "");

let root: string;
let pathFile: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "custom-bun-test-"));
  pathFile = join(root, "github-path");
  writeFileSync(pathFile, "/existing/bin\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(path: string) {
  return spawnSync(
    "bash",
    ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        PATH_TO_BUN_EXECUTABLE: path,
        GITHUB_PATH: pathFile,
      },
    },
  );
}

describe("custom Bun setup", () => {
  test.each([
    ["/custom/bin/bun", "/existing/bin\n/custom/bin\n"],
    ["/custom path/bin/bun", "/existing/bin\n/custom path/bin\n"],
    ["-n/bun", "/existing/bin\n-n\n"],
  ])("adds exactly one directory for the Bun path %p", (path, expected) => {
    const result = setup(path);

    expect(result.status).toBe(0);
    expect(readFileSync(pathFile, "utf8")).toBe(expected);
  });

  test.each([
    "/trusted/bin\n/injected/bin/bun",
    "/trusted/bin\r/injected/bin/bun",
  ])("rejects CR/LF without changing the job's PATH file: %p", (path) => {
    const result = setup(path);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not contain CR or LF");
    expect(readFileSync(pathFile, "utf8")).toBe("/existing/bin\n");
  });
});
