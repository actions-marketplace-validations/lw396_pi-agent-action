/**
 * Unfinished work from a failed tag-mode run.
 *
 * When pi fails (a model outage, a crash, a timeout inside the Runner), the
 * agent's changes exist only in the runner's checkout, which the job throws
 * away. saveUnfinishedWork commits what is left and pushes it to the run's
 * branch, so nothing is lost. On an issue the commit carries a WIP trailer,
 * and the next tag-mode run on the same issue checks that branch out again
 * (findResumableWipBranch) instead of starting a new one from the base branch.
 */

import { execFileSync } from "child_process";
import type { Octokits } from "../api/client";
import { GITHUB_SERVER_URL } from "../api/config";
import { redactSecrets } from "../utils/sanitizer";

/** The commit trailer that marks a branch as unfinished work to resume. */
export const WIP_TRAILER = "Pi-Agent-Wip";

/** Never staged by the WIP commit: see saveUnfinishedWork. */
const WORKFLOWS_DIR = ".github/workflows";

export type WipEntity = { type: "issue" | "pr"; number: number };

/** Where a failed run may save its unfinished work. */
export type WipTarget = {
  /** The branch the run checked out and the agent publishes to. */
  branch: string;
  /** HEAD when the run started: commits after it are the run's work. */
  startSha: string;
  /**
   * Untracked files that were there before the agent ran, written by earlier
   * workflow steps (a test config with credentials, say). Not the agent's
   * work, so never staged.
   */
  preexistingUntracked: string[];
  entity: WipEntity;
  /**
   * Mark the branch for the next run to resume. Set for branches the action
   * created for an issue; a pull request's next run uses its branch anyway.
   */
  resumable: boolean;
};

export type WipSaveResult =
  | { status: "nothing" }
  | { status: "skipped"; reason: string }
  | { status: "saved"; branch: string; sha: string; resumable: boolean }
  | { status: "failed"; branch: string; error: string };

/** The trailer's value: which issue or pull request the work belongs to. */
export function wipTrailerValue(entity: WipEntity): string {
  return `${entity.type} #${entity.number}`;
}

/** Whether a commit message carries the WIP trailer for this entity. */
export function isWipCommitFor(message: string, entity: WipEntity): boolean {
  const line = `${WIP_TRAILER}: ${wipTrailerValue(entity)}`;
  return message.split(/\r?\n/).some((l) => l.trim() === line);
}

export function wipCommitMessage(entity: WipEntity, runUrl: string): string {
  return [
    "WIP: save unfinished work from a failed pi run",
    "",
    `The pi run for ${wipTrailerValue(entity)} failed before it finished.`,
    "This commit keeps what it left in the working tree so the next run can",
    "continue from here. It may not build or pass tests.",
    "",
    `Run: ${runUrl}`,
    `${WIP_TRAILER}: ${wipTrailerValue(entity)}`,
  ].join("\n");
}

// Hooks are off for the action's own commit and push: the agent can edit
// files a hook path such as .husky/ points at, and this runs after the agent
// with the job's credentials.
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

function git(args: string[], timeout = 120_000): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    timeout,
  }).trim();
}

function gitSucceeds(args: string[]): boolean {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr: unknown }).stderr ?? "").trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Commit what the agent left in the working tree and push the branch, after
 * a failed run. Does nothing when the run made no commits and left nothing
 * to commit. Never throws: the caller is the run's cleanup.
 *
 * Not staged: paths in excludePaths (config restored from the base branch,
 * which must not be committed back), untracked files that were there before
 * the run, and .github/workflows/, which the pi-agent-action app token cannot
 * push: GitHub would reject the whole push.
 */
export function saveUnfinishedWork(
  target: WipTarget,
  options: { runUrl: string; excludePaths?: string[] },
): WipSaveResult {
  const { branch, startSha, entity, resumable } = target;
  try {
    const current = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (current !== branch) {
      const reason = `the checkout is on ${current}, not ${branch}`;
      console.log(`Not saving unfinished work: ${reason}`);
      return { status: "skipped", reason };
    }

    const excluded = [
      ...(options.excludePaths ?? []),
      ...target.preexistingUntracked,
      WORKFLOWS_DIR,
    ];
    // Literal paths: a file name may contain pathspec magic characters.
    const pathspec = [
      "--",
      ".",
      ...excluded.map((p) => `:(exclude,literal)${p}`),
    ];
    git(["add", "-A", ...pathspec]);
    // Also unstage workflow changes the agent staged itself.
    git(["reset", "-q", "--", WORKFLOWS_DIR]);
    const hasStaged = !gitSucceeds(["diff", "--cached", "--quiet"]);
    const hasCommits = git(["rev-parse", "HEAD"]) !== startSha;

    const leftOut = git(["status", "--porcelain", "--", WORKFLOWS_DIR]);
    if (leftOut) {
      console.log(
        `Not saving changes under ${WORKFLOWS_DIR}/ (the push would be rejected):\n${leftOut}`,
      );
    }

    if (!hasStaged && !hasCommits) {
      console.log("The failed run left no unfinished work to save");
      return { status: "nothing" };
    }

    // Uncommitted changes always get a commit. With only the agent's own
    // commits, an issue branch still gets an empty one: its trailer is what
    // lets the next run find the branch and resume it.
    if (hasStaged || resumable) {
      git([
        ...NO_HOOKS,
        "commit",
        "--no-verify",
        ...(hasStaged ? [] : ["--allow-empty"]),
        "-m",
        wipCommitMessage(entity, options.runUrl),
      ]);
    }

    // Not forced: if the branch moved on GitHub meanwhile, the push fails
    // rather than overwrite it.
    git([
      ...NO_HOOKS,
      "push",
      "--no-verify",
      "origin",
      `HEAD:refs/heads/${branch}`,
    ]);
    const sha = git(["rev-parse", "HEAD"]);
    console.log(`✅ Saved unfinished work to ${branch} (${sha})`);
    return { status: "saved", branch, sha, resumable };
  } catch (error) {
    const message = errorText(error);
    console.error(`Failed to save unfinished work to ${branch}: ${message}`);
    return { status: "failed", branch, error: message };
  }
}

export function wipClosedMessage(wipSha: string, runUrl: string): string {
  return [
    "chore: close unfinished work from an earlier pi run",
    "",
    `The run below resumed this branch from WIP commit ${wipSha} and ended`,
    "without new commits. This empty commit ends the WIP, so the next run",
    "on the same issue starts a new branch instead of resuming this one.",
    "",
    `Run: ${runUrl}`,
  ].join("\n");
}

export type WipCloseResult = "closed" | "moved" | "failed";

/**
 * After a resumed run that succeeded: if the branch on GitHub still ends at
 * the WIP commit it resumed (the agent pushed nothing), push an empty commit
 * on top of it, so the branch is no longer found as unfinished work. Without
 * it a run that only checked the work, or reported a blocker, would leave
 * the WIP in place, and the next request on the issue, even an unrelated
 * one, would resume it and be told an earlier run had failed.
 *
 * The commit is built from the WIP commit alone (git commit-tree), so
 * nothing the agent left in the checkout, staged or committed but not
 * pushed, is published. Never throws: the caller is the run's cleanup.
 */
export function closeResumedWip(
  branch: string,
  wipSha: string,
  runUrl: string,
): WipCloseResult {
  try {
    const remote = git(
      ["ls-remote", "origin", `refs/heads/${branch}`],
      60_000,
    ).split("\t")[0];
    if (remote !== wipSha) {
      console.log(
        `${branch} moved past the WIP commit it resumed; nothing to close`,
      );
      return "moved";
    }
    // commit-tree is plumbing and ignores commit.gpgsign: sign explicitly
    // when the run signs commits (ssh_signing_key).
    const sign = gitSucceeds(["config", "--bool", "--get", "commit.gpgsign"])
      ? git(["config", "--bool", "--get", "commit.gpgsign"]) === "true"
      : false;
    const closing = git([
      "commit-tree",
      ...(sign ? ["-S"] : []),
      `${wipSha}^{tree}`,
      "-p",
      wipSha,
      "-m",
      wipClosedMessage(wipSha, runUrl),
    ]);
    // Not forced: fails if the branch moved since the check above.
    git([
      ...NO_HOOKS,
      "push",
      "--no-verify",
      "origin",
      `${closing}:refs/heads/${branch}`,
    ]);
    console.log(`Closed the resumed WIP on ${branch} with ${closing}`);
    return "closed";
  } catch (error) {
    console.error(
      `Failed to close the resumed WIP on ${branch}: ${errorText(error)}`,
    );
    return "failed";
  }
}

/** Untracked, not ignored files in the checkout, relative to its root. */
export function listUntrackedFiles(): string[] {
  return git(["ls-files", "-z", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean);
}

/** The tracking comment's note on the saved work, or "" for none. */
export function wipCommentNote(
  result: WipSaveResult | undefined,
  owner: string,
  repo: string,
  triggerPhrase: string,
): string {
  if (!result) return "";
  if (result.status === "saved") {
    const commitUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/commit/${result.sha}`;
    const next = result.resumable
      ? `Mention ${triggerPhrase} here again and the next run continues on this branch.`
      : `Mention ${triggerPhrase} on this pull request again to continue.`;
    return `Unfinished work was saved to \`${result.branch}\` in [${result.sha.slice(0, 7)}](${commitUrl}). ${next}`;
  }
  if (result.status === "failed") {
    return `Saving the unfinished work to \`${result.branch}\` failed, so it was lost:\n\`\`\`\n${redactSecrets(result.error)}\n\`\`\``;
  }
  return "";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Patterns for the names the action gives this entity's branches: the
 * default format, and branch_name_template when it names the entity number.
 * Variables that change from run to run (timestamp, sha, label,
 * description) match anything. A template without {{entityNumber}} cannot
 * tell this entity's branches from others, so only the default format is
 * searched then.
 */
export function wipBranchPatterns(
  template: string | undefined,
  branchPrefix: string,
  entity: WipEntity,
): RegExp[] {
  const patterns: RegExp[] = [];
  // generateBranchName lowercases the default format and cuts it at 50.
  const head = `${branchPrefix}${entity.type}-${entity.number}-`.toLowerCase();
  if (head.length + "yyyymmdd-hhmm".length <= 50) {
    patterns.push(new RegExp(`^${escapeRegExp(head)}\\d{8}-\\d{4}$`));
  }
  if (template?.includes("{{entityNumber}}")) {
    const fixed: Record<string, string> = {
      prefix: branchPrefix,
      entityType: entity.type,
      entityNumber: String(entity.number),
    };
    const source = template
      .split(/(\{\{\w+\}\})/)
      .map((part) => {
        const name = part.match(/^\{\{(\w+)\}\}$/)?.[1];
        if (name === undefined) return escapeRegExp(part);
        return name in fixed ? escapeRegExp(fixed[name]!) : ".*";
      })
      .join("");
    patterns.push(new RegExp(`^${source}$`));
  }
  return patterns;
}

/** At most this many matching branches have their head commit read. */
const MAX_CANDIDATES = 10;

/**
 * The newest branch on origin whose name is one of this entity's and whose
 * head commit carries the WIP trailer for it, or undefined. Lookup errors
 * are logged and treated as none found: the run then starts a new branch.
 */
export async function findResumableWipBranch(
  octokits: Octokits,
  options: {
    owner: string;
    repo: string;
    entity: WipEntity;
    branchPrefix: string;
    branchNameTemplate?: string;
  },
): Promise<{ branch: string; sha: string } | undefined> {
  const { owner, repo, entity } = options;
  const patterns = wipBranchPatterns(
    options.branchNameTemplate,
    options.branchPrefix,
    entity,
  );
  if (patterns.length === 0) return undefined;

  try {
    const heads = git(["ls-remote", "--heads", "origin"], 60_000)
      .split("\n")
      .map((line) => line.split("\t"))
      .flatMap(([sha, ref]) =>
        sha && ref?.startsWith("refs/heads/")
          ? [{ sha, branch: ref.slice("refs/heads/".length) }]
          : [],
      )
      .filter(({ branch }) => patterns.some((p) => p.test(branch)))
      // Newest first for timestamped names, before the cap drops any.
      .sort((a, b) => b.branch.localeCompare(a.branch))
      .slice(0, MAX_CANDIDATES);

    let newest: { branch: string; sha: string; date: number } | undefined;
    for (const head of heads) {
      const { data } = await octokits.rest.git.getCommit({
        owner,
        repo,
        commit_sha: head.sha,
      });
      if (!isWipCommitFor(data.message, entity)) continue;
      const date = Date.parse(data.committer.date);
      if (!newest || date > newest.date) newest = { ...head, date };
    }
    return newest && { branch: newest.branch, sha: newest.sha };
  } catch (error) {
    console.error(
      `Could not look for unfinished work to resume: ${errorText(error)}`,
    );
    return undefined;
  }
}
