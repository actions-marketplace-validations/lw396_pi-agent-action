#!/usr/bin/env bun
/**
 * Posts the inline comments the inline comment server buffered during the
 * session (src/mcp/inline-comment-buffer.ts): each is classified as real
 * review feedback or a test/probe through pi (src/runner/classify-comments.ts),
 * and only the real ones are posted. Calls with confirmed=false are never
 * posted.
 *
 * When classification is not possible (no model, no credentials, a failed
 * request), every comment with confirmed !== false is posted, as Upstream
 * does without an Anthropic key.
 */
import { rmSync } from "fs";
import { createOctokit } from "../github/api/client";
import { redactSecrets } from "../github/utils/sanitizer";
import { collectSecretValues } from "../runner/secret-values";
import { readRunnerInputs } from "../runner/run-plan";
import {
  inlineCommentBufferPath,
  readBufferedComments,
  type BufferedComment,
} from "../mcp/inline-comment-buffer";
import { classifyComments } from "../runner/classify-comments";

export type PostAdapters = {
  /**
   * True for real review feedback, false for a test/probe, per body; null
   * when classification is not possible.
   */
  classify(bodies: string[]): Promise<boolean[] | null>;
  /** Post one comment; false when GitHub rejects it. */
  post(comment: BufferedComment): Promise<boolean>;
};

export type PostOutcome = {
  posted: BufferedComment[];
  /** Posting failed. */
  failed: BufferedComment[];
  /** Classified as a test/probe. */
  filtered: BufferedComment[];
  /** Buffered with confirmed=false. */
  unconfirmed: BufferedComment[];
};

/** Classify the buffered comments and post the real ones, in order. */
export async function postBufferedComments(
  comments: BufferedComment[],
  adapters: PostAdapters,
): Promise<PostOutcome> {
  const outcome: PostOutcome = {
    posted: [],
    failed: [],
    filtered: [],
    unconfirmed: comments.filter((c) => c.confirmed === false),
  };
  const candidates = comments.filter((c) => c.confirmed !== false);
  if (outcome.unconfirmed.length > 0) {
    console.log(
      `  ${outcome.unconfirmed.length} with confirmed=false — not posting`,
    );
  }
  if (candidates.length === 0) return outcome;

  const verdicts = await adapters.classify(candidates.map((c) => c.body));
  const toPost =
    verdicts === null
      ? candidates
      : candidates.filter((_, i) => verdicts[i] === true);
  outcome.filtered =
    verdicts === null ? [] : candidates.filter((_, i) => verdicts[i] === false);

  if (outcome.filtered.length > 0) {
    console.log(
      `::warning::${outcome.filtered.length} buffered comment(s) classified as test/probe — NOT posted:`,
    );
    for (const c of outcome.filtered) {
      console.log(`  [${c.path}:${c.line}] ${c.body.slice(0, 120)}`);
    }
  }
  if (toPost.length === 0) {
    console.log("No real comments to post");
    return outcome;
  }

  console.log(`Posting ${toPost.length} classified-as-real comment(s)`);
  for (const c of toPost) {
    if (await adapters.post(c)) {
      console.log(`  posted ${c.path}:${c.line}`);
      outcome.posted.push(c);
    } else {
      outcome.failed.push(c);
    }
  }
  console.log(`Posted ${outcome.posted.length}/${toPost.length}`);
  return outcome;
}

/** Post review comments on a pull request, on its head commit by default. */
function gitHubPoster(
  githubToken: string,
  owner: string,
  repo: string,
  pull_number: number,
): PostAdapters["post"] {
  const octokit = createOctokit(githubToken).rest;
  let headSha: Promise<string> | undefined;

  return async (c) => {
    headSha ??= octokit.pulls
      .get({ owner, repo, pull_number })
      .then((pr) => pr.data.head.sha);
    const params: Parameters<typeof octokit.pulls.createReviewComment>[0] = {
      owner,
      repo,
      pull_number,
      body: redactSecrets(c.body),
      path: c.path,
      side: c.side || "RIGHT",
      commit_id: c.commit_id || (await headSha),
      line: c.line,
    };
    if (c.startLine) {
      params.start_line = c.startLine;
      params.start_side = c.side || "RIGHT";
    }
    try {
      await octokit.pulls.createReviewComment(params);
      return true;
    } catch (e) {
      console.log(
        `  failed ${c.path}:${c.line}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  };
}

async function main() {
  collectSecretValues(process.env);
  const bufferPath = inlineCommentBufferPath();
  const comments = readBufferedComments(bufferPath);
  // Posted or not, these comments belong to this run only.
  rmSync(bufferPath, { force: true });
  if (comments.length === 0) {
    console.log("No buffered inline comments");
    return;
  }
  console.log(`Found ${comments.length} buffered inline comment(s)`);

  const { GITHUB_TOKEN, REPO_OWNER, REPO_NAME, PR_NUMBER } = process.env;
  if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME || !PR_NUMBER) {
    console.log(
      "::warning::Missing GITHUB_TOKEN/REPO_OWNER/REPO_NAME/PR_NUMBER — cannot post buffered comments",
    );
    return;
  }

  await postBufferedComments(comments, {
    classify: async (bodies) => {
      try {
        const runnerInputs = readRunnerInputs(process.env);
        return await classifyComments(bodies, {
          model: runnerInputs.model,
          classifyModel: process.env.CLASSIFY_MODEL,
          apiKey: runnerInputs.apiKey,
          baseUrls: runnerInputs.baseUrls,
        });
      } catch (error) {
        // Invalid runner configuration must not prevent the always() step
        // from posting candidates, just like any other classification failure.
        const message = error instanceof Error ? error.message : String(error);
        console.log(
          `Classification configuration failed (${redactSecrets(message)}) — posting all unconfirmed comments`,
        );
        return null;
      }
    },
    post: gitHubPoster(
      GITHUB_TOKEN,
      REPO_OWNER,
      REPO_NAME,
      parseInt(PR_NUMBER, 10),
    ),
  });
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("post-buffered-inline-comments failed:", e);
    process.exit(1);
  });
}
