import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

export type RunSettings = Record<string, unknown>;

function isObject(value: unknown): value is RunSettings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON only, with no input values or parser excerpts in errors. */
export function parseSettings(
  input: string | undefined,
): RunSettings | undefined {
  if (!input?.trim()) return undefined;
  let settings: unknown;
  try {
    settings = JSON.parse(input, (key, value) => {
      // pi also merges these objects internally; reject prototype-mutating keys
      // before either our merge or the SDK sees them, including inside arrays.
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        throw new Error("Unsafe settings key");
      }
      return value;
    });
  } catch {
    throw new Error(
      "settings must be a valid JSON object without prototype-mutating keys.",
    );
  }
  if (!isObject(settings)) throw new Error("settings must be a JSON object.");
  return settings;
}

/** Objects merge recursively; arrays, null and scalars replace the old value. */
function mergeSettings(base: RunSettings, additions: RunSettings): RunSettings {
  return Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(additions)])].map(
      (key) => {
        if (!Object.hasOwn(additions, key)) return [key, base[key]];
        const previous = base[key];
        const next = additions[key];
        return [
          key,
          isObject(previous) && isObject(next)
            ? mergeSettings(previous, next)
            : next,
        ];
      },
    ),
  );
}

/**
 * The SDK and file-reading plugins share a temporary settings file when the
 * workflow supplies settings. Without the input, keep the in-memory behavior.
 * The SDK's project scope also points inside agentDir, never at the checkout.
 */
export async function withRunSettings<T>(
  agentDir: string,
  additions: RunSettings | undefined,
  maxRetries: number | undefined,
  run: (manager: SettingsManager) => Promise<T>,
): Promise<T> {
  const path = join(agentDir, "settings.json");
  let base: RunSettings = {};
  if (additions !== undefined) {
    try {
      base = parseSettings(readFileSync(path, "utf8")) ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let settings = mergeSettings(base, additions ?? {});
  // Action-specific options win, without dropping other retry settings.
  if (maxRetries !== undefined) {
    settings = mergeSettings(settings, { retry: { maxRetries } });
  }
  if (additions === undefined) return run(SettingsManager.inMemory(settings));

  await writeFile(path, JSON.stringify(settings, null, 2) + "\n", {
    mode: 0o600,
  });
  const manager = SettingsManager.create(agentDir, agentDir, {
    projectTrusted: true,
  });
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await run(manager);
  } finally {
    try {
      await manager.flush();
    } finally {
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
    }
  }
}
