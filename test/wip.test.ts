#!/usr/bin/env bun

/**
 * Saving a failed run's unfinished work, and finding it again for the next
 * run (src/github/operations/wip.ts). Runs against real git with a local bare
 * remote: what matters is what git commits and pushes.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokits } from "../src/github/api/client";
import { setupBranch } from "../src/github/operations/branch";
import {
  closeResumedWip,
  findResumableWipBranch,
  isWipCommitFor,
  saveUnfinishedWork,
  wipBranchPatterns,
  wipCommentNote,
  wipCommitMessage,
  type WipTarget,
} from "../src/github/operations/wip";
import { unfinishedWorkTarget } from "../src/modes/tag";
import { createMockContext } from "./mockContext";

const BRANCH = "pi/issue-7-20260101-0000";
const RUN_URL = "https://github.com/owner/repo/actions/runs/1";
const ISSUE_7 = { type: "issue", number: 7 } as const;

let root: string;
let workDir: string;
let remoteDir: string;
let originalCwd: string;
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: workDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function remoteGit(...args: string[]): string {
  return execFileSync("git", ["--git-dir", remoteDir, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(relative: string, contents: string) {
  const full = join(workDir, relative);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

function commit(message: string) {
  git("add", "-A");
  git("commit", "-qm", message);
}

/** An octokit whose git.getCommit reads the commit from the bare remote. */
function octokitFromRemote(): Octokits {
  return {
    rest: {
      git: {
        getCommit: async ({ commit_sha }: { commit_sha: string }) => ({
          data: {
            message: remoteGit("log", "-1", "--format=%B", commit_sha),
            committer: {
              date: remoteGit("log", "-1", "--format=%cI", commit_sha),
            },
          },
        }),
        getRef: async () => ({
          data: { object: { sha: remoteGit("rev-parse", "main") } },
        }),
      },
      repos: { get: async () => ({ data: { default_branch: "main" } }) },
    },
  } as unknown as Octokits;
}

function target(overrides: Partial<WipTarget> = {}): WipTarget {
  return {
    branch: BRANCH,
    startSha: git("rev-parse", "HEAD"),
    preexistingUntracked: [],
    entity: ISSUE_7,
    resumable: true,
    ...overrides,
  };
}

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "wip-"));
  remoteDir = join(root, "remote.git");
  workDir = join(root, "work");

  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remoteDir]);
  execFileSync("git", ["init", "-q", "-b", "main", workDir]);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("remote", "add", "origin", remoteDir);
  write("src/app.ts", "base\n");
  commit("base");
  git("push", "-q", "origin", "main");
  git("checkout", "-qb", BRANCH);

  process.chdir(workDir);
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(originalCwd);
  logSpy.mockRestore();
  errorSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe("saveUnfinishedWork", () => {
  test("does nothing when the run left no work", () => {
    const result = saveUnfinishedWork(target(), { runUrl: RUN_URL });

    expect(result).toEqual({ status: "nothing" });
    expect(() => remoteGit("rev-parse", "--verify", BRANCH)).toThrow();
  });

  test("commits uncommitted changes with the WIP trailer and pushes the branch", () => {
    const start = target();
    write("src/app.ts", "half done\n");
    write("src/new.ts", "new file\n");

    const result = saveUnfinishedWork(start, { runUrl: RUN_URL });

    const remoteHead = remoteGit("rev-parse", BRANCH);
    expect(result).toEqual({
      status: "saved",
      branch: BRANCH,
      sha: remoteHead,
      resumable: true,
    });
    const message = remoteGit("log", "-1", "--format=%B", BRANCH);
    expect(message).toStartWith("WIP: save unfinished work");
    expect(message).toContain(`Run: ${RUN_URL}`);
    expect(isWipCommitFor(message, ISSUE_7)).toBe(true);
    expect(remoteGit("show", `${BRANCH}:src/app.ts`)).toBe("half done");
    expect(remoteGit("show", `${BRANCH}:src/new.ts`)).toBe("new file");
  });

  test("pushes the agent's unpushed commits under an empty WIP commit on an issue branch", () => {
    const start = target();
    write("src/app.ts", "step one\n");
    commit("feat: step one");

    const result = saveUnfinishedWork(start, { runUrl: RUN_URL });

    expect(result.status).toBe("saved");
    expect(
      remoteGit("log", "--format=%s", `main..${BRANCH}`).split("\n"),
    ).toEqual([
      "WIP: save unfinished work from a failed pi run",
      "feat: step one",
    ]);
  });

  test("pushes a pull request branch's commits without a WIP commit", () => {
    git("push", "-q", "origin", BRANCH);
    const start = target({
      entity: { type: "pr", number: 3 },
      resumable: false,
    });
    write("src/app.ts", "fix\n");
    commit("fix: review comment");

    const result = saveUnfinishedWork(start, { runUrl: RUN_URL });

    expect(result).toMatchObject({ status: "saved", resumable: false });
    expect(remoteGit("log", "-1", "--format=%s", BRANCH)).toBe(
      "fix: review comment",
    );
  });

  test("leaves out restored config, workflow files and files from earlier steps", () => {
    write("config/local.yml", "password: from-an-earlier-step\n");
    const start = target({ preexistingUntracked: ["config/local.yml"] });
    write("AGENTS.md", "restored from base\n");
    write(".github/workflows/ci.yml", "on: push\n");
    write(".github/workflows/staged.yml", "on: push\n");
    git("add", ".github/workflows/staged.yml");
    write("src/app.ts", "work\n");

    saveUnfinishedWork(start, {
      runUrl: RUN_URL,
      excludePaths: ["AGENTS.md"],
    });

    const files = remoteGit("ls-tree", "-r", "--name-only", BRANCH).split("\n");
    expect(files).toEqual(["src/app.ts"]);
  });

  test("does not run the repository's git hooks", () => {
    const start = target();
    write(".hooks/pre-commit", "#!/bin/sh\nexit 1\n");
    write(".hooks/pre-push", "#!/bin/sh\nexit 1\n");
    chmodSync(join(workDir, ".hooks/pre-commit"), 0o755);
    chmodSync(join(workDir, ".hooks/pre-push"), 0o755);
    git("config", "core.hooksPath", ".hooks");
    write("src/app.ts", "work\n");

    expect(saveUnfinishedWork(start, { runUrl: RUN_URL }).status).toBe("saved");
  });

  test("skips a checkout that is not on the target branch", () => {
    const start = target();
    git("checkout", "-q", "main");
    write("src/app.ts", "work\n");

    expect(saveUnfinishedWork(start, { runUrl: RUN_URL })).toMatchObject({
      status: "skipped",
    });
  });

  test("reports a rejected push instead of throwing or forcing it", () => {
    git("push", "-q", "origin", BRANCH);
    const start = target();
    // The branch moved on GitHub meanwhile.
    const other = join(root, "other");
    execFileSync("git", ["clone", "-q", "-b", BRANCH, remoteDir, other]);
    writeFileSync(join(other, "x.txt"), "x\n");
    execFileSync("git", ["-C", other, "add", "."]);
    execFileSync("git", [
      "-C",
      other,
      "-c",
      "user.name=O",
      "-c",
      "user.email=o@example.com",
      "commit",
      "-qm",
      "other",
    ]);
    execFileSync("git", ["-C", other, "push", "-q", "origin", BRANCH]);
    const remoteBefore = remoteGit("rev-parse", BRANCH);
    write("src/app.ts", "work\n");

    const result = saveUnfinishedWork(start, { runUrl: RUN_URL });

    expect(result).toMatchObject({ status: "failed", branch: BRANCH });
    expect(remoteGit("rev-parse", BRANCH)).toBe(remoteBefore);
  });
});

describe("wipBranchPatterns", () => {
  test("matches the default branch name format for the entity only", () => {
    const [pattern] = wipBranchPatterns(undefined, "pi/", ISSUE_7);
    expect(pattern!.test("pi/issue-7-20260101-0000")).toBe(true);
    expect(pattern!.test("pi/issue-70-20260101-0000")).toBe(false);
    expect(pattern!.test("pi/pr-7-20260101-0000")).toBe(false);
  });

  test("matches a template that names the entity number, with other variables as wildcards", () => {
    const patterns = wipBranchPatterns(
      "{{prefix}}{{entityType}}/{{entityNumber}}-{{description}}",
      "pi/",
      ISSUE_7,
    );
    expect(patterns).toHaveLength(2);
    expect(patterns[1]!.test("pi/issue/7-add-login")).toBe(true);
    expect(patterns[1]!.test("pi/issue/71-add-login")).toBe(false);
  });

  test("falls back to the default format for a template without the entity number", () => {
    expect(
      wipBranchPatterns("{{prefix}}{{timestamp}}", "pi/", ISSUE_7),
    ).toHaveLength(1);
  });
});

describe("findResumableWipBranch", () => {
  function pushBranch(name: string, message: string) {
    git("checkout", "-q", "-B", name, "main");
    write("src/app.ts", `${name}\n`);
    git("add", "-A");
    git("commit", "-qm", message);
    git("push", "-q", "origin", name);
  }

  const options = {
    owner: "owner",
    repo: "repo",
    entity: ISSUE_7,
    branchPrefix: "pi/",
  };

  test("finds the newest branch for the entity whose head is a WIP commit", async () => {
    pushBranch("pi/issue-7-20260101-0000", wipCommitMessage(ISSUE_7, RUN_URL));
    pushBranch("pi/issue-7-20260102-0000", wipCommitMessage(ISSUE_7, RUN_URL));
    // Finished: its head is a normal commit.
    pushBranch("pi/issue-7-20260103-0000", "feat: done");
    pushBranch(
      "pi/issue-8-20260104-0000",
      wipCommitMessage({ type: "issue", number: 8 }, RUN_URL),
    );

    const found = await findResumableWipBranch(octokitFromRemote(), options);

    expect(found).toEqual({
      branch: "pi/issue-7-20260102-0000",
      sha: remoteGit("rev-parse", "pi/issue-7-20260102-0000"),
    });
  });

  test("ignores a WIP commit that belongs to another entity", async () => {
    pushBranch(
      "pi/issue-7-20260101-0000",
      wipCommitMessage({ type: "pr", number: 7 }, RUN_URL),
    );

    expect(
      await findResumableWipBranch(octokitFromRemote(), options),
    ).toBeUndefined();
  });

  test("treats a lookup error as nothing to resume", async () => {
    pushBranch("pi/issue-7-20260101-0000", wipCommitMessage(ISSUE_7, RUN_URL));
    const failing = {
      rest: {
        git: {
          getCommit: async () => {
            throw new Error("API down");
          },
        },
      },
    } as unknown as Octokits;

    expect(await findResumableWipBranch(failing, options)).toBeUndefined();
  });
});

describe("setupBranch", () => {
  test("checks out an issue's WIP branch instead of creating a new one", async () => {
    git("checkout", "-q", "-B", BRANCH, "main");
    write("src/app.ts", "half done\n");
    git("add", "-A");
    git("commit", "-qm", wipCommitMessage(ISSUE_7, RUN_URL));
    git("push", "-q", "origin", BRANCH);
    const wipSha = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    git("branch", "-qD", BRANCH);

    const context = createMockContext({
      isPR: false,
      entityNumber: 7,
      inputs: { useCommitSigning: false, branchPrefix: "pi/" },
    });
    const info = await setupBranch(
      octokitFromRemote(),
      { contextData: { title: "Add feature", labels: { nodes: [] } } } as any,
      context,
    );

    expect(info).toEqual({
      baseBranch: "main",
      agentBranch: BRANCH,
      currentBranch: BRANCH,
      resumedWip: { sha: wipSha },
    });
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
    expect(git("rev-parse", "HEAD")).toBe(wipSha);
  });
});

describe("closeResumedWip", () => {
  /** A WIP branch on the remote, checked out as a resumed run would. */
  function resumedBranch(): string {
    write("src/app.ts", "half done\n");
    commit(wipCommitMessage(ISSUE_7, RUN_URL));
    git("push", "-q", "origin", BRANCH);
    return git("rev-parse", "HEAD");
  }

  const findOptions = {
    owner: "owner",
    repo: "repo",
    entity: ISSUE_7,
    branchPrefix: "pi/",
  };

  test("ends a WIP the run left untouched, so the next run starts a new branch", async () => {
    const wipSha = resumedBranch();

    expect(closeResumedWip(BRANCH, wipSha, RUN_URL)).toBe("closed");

    const head = remoteGit("rev-parse", BRANCH);
    expect(remoteGit("rev-parse", `${head}^`)).toBe(wipSha);
    expect(remoteGit("rev-parse", `${head}^{tree}`)).toBe(
      remoteGit("rev-parse", `${wipSha}^{tree}`),
    );
    expect(remoteGit("log", "-1", "--format=%s", head)).toBe(
      "chore: close unfinished work from an earlier pi run",
    );
    expect(
      await findResumableWipBranch(octokitFromRemote(), findOptions),
    ).toBeUndefined();
  });

  test("publishes nothing the agent left unpushed", () => {
    const wipSha = resumedBranch();
    write("src/app.ts", "committed, not pushed\n");
    commit("feat: local only");
    write("src/app.ts", "staged\n");
    git("add", "-A");

    expect(closeResumedWip(BRANCH, wipSha, RUN_URL)).toBe("closed");

    const head = remoteGit("rev-parse", BRANCH);
    expect(remoteGit("show", `${head}:src/app.ts`)).toBe("half done");
    // The agent's checkout is left as it was.
    expect(git("log", "-1", "--format=%s")).toBe("feat: local only");
    expect(git("diff", "--cached", "--name-only")).toBe("src/app.ts");
  });

  test("leaves a branch the agent pushed to", () => {
    const wipSha = resumedBranch();
    write("src/app.ts", "done\n");
    commit("feat: finish");
    git("push", "-q", "origin", BRANCH);
    const pushed = git("rev-parse", "HEAD");

    expect(closeResumedWip(BRANCH, wipSha, RUN_URL)).toBe("moved");
    expect(remoteGit("rev-parse", BRANCH)).toBe(pushed);
  });
});

describe("wipCommentNote", () => {
  test("links the saved commit and says how to continue", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const note = wipCommentNote(
      { status: "saved", branch: BRANCH, sha, resumable: true },
      "owner",
      "repo",
      "@pi",
    );
    expect(note).toContain(`\`${BRANCH}\``);
    expect(note).toContain(
      `[0123456](https://github.com/owner/repo/commit/${sha})`,
    );
    expect(note).toContain("Mention @pi here again");
  });

  test("redacts credentials in a failed push's error", () => {
    const note = wipCommentNote(
      {
        status: "failed",
        branch: BRANCH,
        error:
          "fatal: https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r.git",
      },
      "owner",
      "repo",
      "@pi",
    );
    expect(note).toContain("failed, so it was lost");
    expect(note).not.toContain("ghs_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  test("says nothing when there was nothing to save", () => {
    expect(wipCommentNote({ status: "nothing" }, "o", "r", "@pi")).toBe("");
    expect(wipCommentNote(undefined, "o", "r", "@pi")).toBe("");
  });
});

describe("unfinishedWorkTarget", () => {
  const issue = () =>
    createMockContext({ isPR: false, entityNumber: 7, inputs: {} });
  const pr = () =>
    createMockContext({ isPR: true, entityNumber: 3, inputs: {} });

  test("targets the branch the action created, marked to resume", () => {
    const info = {
      baseBranch: "main",
      agentBranch: BRANCH,
      currentBranch: BRANCH,
    };
    write("config/local.yml", "from an earlier step\n");
    expect(unfinishedWorkTarget(info, issue(), "git")).toEqual({
      branch: BRANCH,
      startSha: git("rev-parse", "HEAD"),
      preexistingUntracked: ["config/local.yml"],
      entity: ISSUE_7,
      resumable: true,
    });
  });

  test("targets an open pull request's own branch, not marked to resume", () => {
    const info = { baseBranch: "main", currentBranch: "feature" };
    expect(unfinishedWorkTarget(info, pr(), "ssh-signed")).toMatchObject({
      branch: "feature",
      entity: { type: "pr", number: 3 },
      resumable: false,
    });
  });

  test("has no target for a fork's pull request or API commit signing", () => {
    expect(
      unfinishedWorkTarget(
        { baseBranch: "main", currentBranch: "feature", forkPullRequest: true },
        pr(),
        "git",
      ),
    ).toBeUndefined();
    expect(
      unfinishedWorkTarget(
        { baseBranch: "main", agentBranch: BRANCH, currentBranch: "main" },
        issue(),
        "api",
      ),
    ).toBeUndefined();
  });
});
