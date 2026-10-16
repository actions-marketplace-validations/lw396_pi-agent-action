import { mkdtemp, symlink } from "fs/promises";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, dirname, join } from "path";
import { fileURLToPath } from "url";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * The pi CLI of the SDK the Runner runs: the `pi` bin of the installed
 * @earendil-works/pi-coding-agent. The package's exports hide package.json,
 * so it is found from the main entry, dist/index.js.
 */
export function bundledPiCli(): string {
  const entry = fileURLToPath(import.meta.resolve(PI_PACKAGE));
  const root = dirname(dirname(entry));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const bin =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
  if (manifest.name !== PI_PACKAGE || typeof bin !== "string") {
    throw new Error(`${PI_PACKAGE}: no pi bin in ${root}/package.json`);
  }
  return join(root, bin);
}

/**
 * Put the bundled pi CLI first on PATH as `pi`, for processes the session
 * starts: the Runner runs pi in-process through the SDK, so without this a
 * package that starts pi processes (pi-subagents, for one) finds no `pi` on
 * the runner, or another version. The CLI's shebang runs it with node.
 * Returns the directory added, or undefined on Windows, where a symlinked
 * script cannot run.
 */
export async function putBundledPiOnPath(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  // Its own directory, outside the checkout and pi's agent directory.
  const binDir = await mkdtemp(join(env.RUNNER_TEMP || tmpdir(), "pi-cli-"));
  await symlink(bundledPiCli(), join(binDir, "pi"));
  env.PATH = env.PATH ? `${binDir}${delimiter}${env.PATH}` : binDir;
  return binDir;
}
