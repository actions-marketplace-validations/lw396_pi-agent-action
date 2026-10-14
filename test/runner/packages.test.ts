// Public Runner seam, with real SDK package installation and a local npm
// registry. Only the registry and model provider are substituted.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { runPi } from "../../src/runner/run-pi";
import { fauxRuntime, readExecutionFile, rules, useScratch } from "./harness";

// The tests run real npm and git installs. The first npm run in a CI job
// starts cold (2s to over 5s on GitHub runners, against ~300ms after that),
// which bun's default 5s timeout does not leave room for.
setDefaultTimeout(30_000);

const getScratch = useScratch();
const NPM_SOURCE = "npm:pi-action-test-package@1.2.3";
const ENV_KEYS = [
  "npm_config_registry",
  "npm_config_cache",
  "npm_config_audit",
  "npm_config_fund",
  "npm_config_fetch_retries",
  "PI_OFFLINE",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
];
let savedEnv: Record<string, string | undefined>;
let registry: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.npm_config_cache = join(getScratch().root, "npm-cache");
  process.env.npm_config_audit = "false";
  process.env.npm_config_fund = "false";
  process.env.npm_config_fetch_retries = "0";
  delete process.env.PI_OFFLINE;
});

afterEach(() => {
  registry?.stop(true);
  registry = undefined;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function servePackage(
  files: Record<string, string>,
  pi?: Record<string, string[]>,
) {
  const root = join(getScratch().root, "registry");
  const manifest = {
    name: "pi-action-test-package",
    version: "1.2.3",
    type: "module",
    ...(pi ? { pi } : {}),
  };
  await Bun.write(join(root, "package/package.json"), JSON.stringify(manifest));
  for (const [path, contents] of Object.entries(files)) {
    await Bun.write(join(root, "package", path), contents);
  }
  const tarball = join(root, "package.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
  registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/package.tgz") return new Response(Bun.file(tarball));
      if (path === "/pi-action-test-package") {
        return Response.json({
          name: manifest.name,
          "dist-tags": { latest: manifest.version },
          versions: {
            "1.2.3": {
              ...manifest,
              dist: { tarball: new URL("/package.tgz", request.url).href },
            },
          },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  process.env.npm_config_registry = registry.url.href;
}

const SKILL =
  "---\nname: package-review\ndescription: Review with a package skill.\n---\n\nCheck package-specific invariants.\n";

describe("packages in the Runner", () => {
  test("honors package manifests and keeps explicit prompts when discovery is disabled", async () => {
    await servePackage(
      {
        "resources/review/SKILL.md": SKILL,
        "resources/prompts/package-template.md":
          "Review the package's $1 invariants.",
        "extensions/not-declared.ts":
          'throw new Error("Undeclared extension ran");',
      },
      {
        skills: ["./resources/review"],
        prompts: ["./resources/prompts/*.md"],
        extensions: [],
      },
    );
    await Bun.write(
      join(getScratch().cwd, ".pi/settings.json"),
      JSON.stringify({ packages: ["npm:missing-package@1.2.3"] }),
    );
    await Bun.write(
      join(getScratch().cwd, ".pi/prompts/repo-only.md"),
      "Repository-only prompt.",
    );
    let sent = "";
    const { modelRuntime, model } = await fauxRuntime([
      (context) => {
        sent = JSON.stringify(context.messages);
        return fauxAssistantMessage("Reviewed.");
      },
    ]);

    await runPi("Review.", {
      model,
      modelRuntime,
      cwd: getScratch().cwd,
      packages: [NPM_SOURCE],
      piArgs: "--no-skills --no-prompt-templates",
      userRequest: "/package-template auth",
    });

    expect(sent).toContain("Review the package's auth invariants.");
    expect(sent).toContain("package-review");
    expect(sent).not.toContain("repo-only");
  });

  test.each([
    [
      "skills/broken/SKILL.md",
      "---\nname: broken\n---\n\nMissing description.",
    ],
    ["themes/broken.json", "not json"],
  ])(
    "fails before calling the model when package resource %p cannot load",
    async (path, contents) => {
      await servePackage({ [path]: contents });
      const { faux, modelRuntime, model } = await fauxRuntime([
        fauxAssistantMessage("unused"),
      ]);

      await expect(
        runPi("Review.", {
          model,
          modelRuntime,
          cwd: getScratch().cwd,
          packages: [NPM_SOURCE],
        }),
      ).rejects.toThrow("packages: resource loading failed");
      expect(faux.state.callCount).toBe(0);
    },
  );

  test("does not silently skip an explicit package when pi is offline", async () => {
    await servePackage({ "skills/package-review/SKILL.md": SKILL });
    process.env.PI_OFFLINE = "1";
    const { faux, modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage("unused"),
    ]);

    await expect(
      runPi("Review.", {
        model,
        modelRuntime,
        cwd: getScratch().cwd,
        packages: [NPM_SOURCE],
      }),
    ).rejects.toThrow("packages:");
    expect(faux.state.callCount).toBe(0);
  });

  test("loads the selected Git commit rather than the default branch", async () => {
    const root = join(getScratch().root, "git-source");
    const repo = join(root, "review");
    const skillPath = join(repo, "skills/package-review/SKILL.md");
    await Bun.write(skillPath, SKILL);
    const config = join(getScratch().root, "gitconfig");
    await Bun.write(config, "");
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_TERMINAL_PROMPT = "0";
    execFileSync("git", [
      "config",
      "--file",
      config,
      `url.file://${root}/.insteadOf`,
      "https://github.com/package-fixture/",
    ]);
    execFileSync("git", ["init", "-q", "--initial-branch=main", repo]);
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-C",
          repo,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { encoding: "utf8" },
      );
    git("add", ".");
    git("commit", "-qm", "Pinned skill");
    const commit = git("rev-parse", "HEAD").trim();
    await Bun.write(
      skillPath,
      SKILL.replace(
        "Check package-specific invariants.",
        "Unpinned instructions.",
      ),
    );
    git("add", ".");
    git("commit", "-qm", "Changed default branch");
    let sent = "";
    const { modelRuntime, model } = await fauxRuntime([
      (context) => {
        sent = JSON.stringify(context.messages);
        return fauxAssistantMessage("Reviewed.");
      },
    ]);

    await runPi("Review.", {
      model,
      modelRuntime,
      cwd: getScratch().cwd,
      packages: [`git:github.com/package-fixture/review@${commit}`],
      userRequest: "/skill:package-review",
    });

    expect(sent).toContain("Check package-specific invariants.");
    expect(sent).not.toContain("Unpinned instructions.");
  });

  test.each([
    ["", "", false],
    ["package_probe", "", true],
    ["package_probe", "package_probe", false],
  ])(
    "checks package tools against allowed_tools=%p and disallowed_tools=%p",
    async (allowed, disallowed, permitted) => {
      await servePackage({
        "extensions/probe.ts": `
        import { Type } from "@earendil-works/pi-ai";
        import { defineTool } from "@earendil-works/pi-coding-agent";
        export default function (pi) {
          pi.registerTool(defineTool({
            name: "package_probe", label: "Package probe",
            description: "Report the loaded package location.",
            parameters: Type.Object({}),
            async execute() {
              return {
                content: [{ type: "text", text: "Package loaded from " + import.meta.url }],
                details: undefined,
              };
            },
          }));
        }
      `,
      });
      const { modelRuntime, model } = await fauxRuntime([
        fauxAssistantMessage(fauxToolCall("package_probe", {}), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Done."),
      ]);

      const result = await runPi("Probe.", {
        model,
        modelRuntime,
        cwd: getScratch().cwd,
        packages: [NPM_SOURCE],
        allowedTools: rules(allowed),
        disallowedTools: rules(disallowed),
      });
      const tool = readExecutionFile(result.executionFile!).find(
        (record) =>
          record.type === "tool_execution_end" &&
          record.toolName === "package_probe",
      );
      if (permitted) {
        expect(tool?.result.content[0].text).toStartWith(
          `Package loaded from file://${process.env.RUNNER_TEMP}/pi-agent-`,
        );
      } else {
        expect(tool?.result.content[0].text).toContain(
          disallowed ? "disallowed_tools" : "no allowed_tools rule",
        );
        expect(tool?.isError).toBe(true);
      }
    },
  );

  test("reports a package installation failure without calling the model", async () => {
    await servePackage({});
    const { faux, modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage("unused"),
    ]);

    await expect(
      runPi("Review.", {
        model,
        modelRuntime,
        cwd: getScratch().cwd,
        packages: ["npm:missing-package@1.2.3"],
      }),
    ).rejects.toThrow("packages: installation or loading failed");
    expect(faux.state.callCount).toBe(0);
  });

  test("fails before calling the model when a package extension cannot load", async () => {
    await servePackage({
      "extensions/broken.ts":
        'export default function () { throw new Error("Package setup failed"); }',
    });
    const { faux, modelRuntime, model } = await fauxRuntime([
      fauxAssistantMessage("unused"),
    ]);

    await expect(
      runPi("Review.", {
        model,
        modelRuntime,
        cwd: getScratch().cwd,
        packages: [NPM_SOURCE],
      }),
    ).rejects.toThrow("Package setup failed");
    expect(faux.state.callCount).toBe(0);
  });

  test("keeps explicit package skills with --no-skills but drops discovered skills", async () => {
    await servePackage({ "skills/package-review/SKILL.md": SKILL });
    await Bun.write(
      join(getScratch().cwd, ".pi/skills/repo-only/SKILL.md"),
      "---\nname: repo-only\ndescription: A repository skill.\n---\n\nRepository-only instructions.\n",
    );
    let sent = "";
    const { modelRuntime, model } = await fauxRuntime([
      (context) => {
        sent = JSON.stringify(context.messages);
        return fauxAssistantMessage("Reviewed.");
      },
    ]);

    await runPi("Review.", {
      model,
      modelRuntime,
      cwd: getScratch().cwd,
      packages: [NPM_SOURCE],
      piArgs: "--no-skills",
      userRequest: "/skill:package-review",
    });

    expect(sent).toContain("Check package-specific invariants.");
    expect(sent).not.toContain("repo-only");
  });

  test("installs an npm package and expands its skill in the request", async () => {
    await servePackage({ "skills/package-review/SKILL.md": SKILL });
    let sent = "";
    const { modelRuntime, model } = await fauxRuntime([
      (context) => {
        sent = JSON.stringify(context.messages);
        return fauxAssistantMessage("Reviewed.");
      },
    ]);

    await runPi("Review.", {
      model,
      modelRuntime,
      cwd: getScratch().cwd,
      packages: [NPM_SOURCE],
      userRequest: "/skill:package-review",
    });

    expect(sent).toContain("Check package-specific invariants.");
  });
});
