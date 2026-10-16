import {
  DefaultPackageManager,
  type DefaultResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { stripCommentLines } from "./pi-args";

// Restrict npm to registry names with an optional version/range/tag. Local
// tarballs, aliases and URL dependencies are not package sources for this input.
const NPM_SOURCE =
  /^npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9.*+~^-]+)?$/;
const GIT_SOURCE =
  /^git:(?:https?:\/\/)?([a-zA-Z0-9.-]+(?::\d+)?)\/([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+)(?:@[a-zA-Z0-9._][a-zA-Z0-9._\/-]*)?$/;

function isPackageSource(source: string): boolean {
  if (NPM_SOURCE.test(source)) return true;
  const git = GIT_SOURCE.exec(source);
  if (!git) return false;
  const host = git[1]!.split(":")[0]!;
  return (
    (host.includes(".") || host === "localhost") &&
    git[2]!.split("/").every((part) => part !== "." && part !== "..")
  );
}

/** One native pi package source per non-comment line, not a shell command. */
export function parsePackages(text: string | undefined): string[] {
  return stripCommentLines(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((source, index) => {
      if (!isPackageSource(source)) {
        // Do not echo a malformed source: it may contain URL credentials.
        throw new Error(
          `packages: entry ${index + 1} must be an npm: registry package or git: HTTP(S) repository source, optionally pinned with @version or @ref. Local paths, credentials and install flags are not supported.`,
        );
      }
      return source;
    });
}

type PackagePaths = Pick<
  ConstructorParameters<typeof DefaultResourceLoader>[0],
  | "additionalExtensionPaths"
  | "additionalSkillPaths"
  | "additionalPromptTemplatePaths"
  | "additionalThemePaths"
>;

/** Resolve native package resources in pi's temporary scope, without settings writes. */
export async function resolvePackages(
  sources: string[],
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
): Promise<PackagePaths> {
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  try {
    const resources = await manager.resolveExtensionSources(sources, {
      temporary: true,
    });
    const all = Object.values(resources).flat();
    for (const source of sources) {
      if (
        !all.some(
          (resource) => resource.enabled && resource.metadata.source === source,
        )
      ) {
        // pi normally skips missing packages in offline mode. An explicit
        // workflow input must never silently run without its resources.
        throw new Error(
          `${source} has no loadable pi resources (the package may be unavailable in offline mode).`,
        );
      }
    }
    const paths = (kind: keyof typeof resources) =>
      resources[kind]
        .filter((resource) => resource.enabled)
        .map((resource) => resource.path);
    return {
      additionalExtensionPaths: paths("extensions"),
      additionalSkillPaths: paths("skills"),
      additionalPromptTemplatePaths: paths("prompts"),
      additionalThemePaths: paths("themes"),
    };
  } catch (error) {
    throw new Error(
      `packages: installation or loading failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
