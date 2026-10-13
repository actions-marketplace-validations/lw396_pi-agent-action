#!/usr/bin/env bun

import type { FetchDataResult } from "../github/data/fetcher";
import type { ParsedGitHubContext } from "../github/context";
import type { GitHubTokenSource } from "../github/token";
import { extractUserRequest } from "../utils/extract-user-request";
import { generateDefaultPrompt } from "./default-prompt";
import { prepareContext } from "./prepare-context";
import { isCommentEvent } from "./shared";
import { generateSimplePrompt } from "./simple-prompt";
import type { PreparedContext } from "./types";

export type { CommonFields, PreparedContext } from "./types";
export { generateDefaultPrompt } from "./default-prompt";
export { getEventTypeAndContext, prepareContext } from "./prepare-context";

/**
 * The prompt the model gets. Agent mode uses the workflow's prompt as is; tag
 * mode builds one from the GitHub context and appends the workflow's prompt,
 * if any, as <custom_instructions>.
 */
export function generatePrompt(
  context: PreparedContext,
  githubData: FetchDataResult,
  useCommitSigning: boolean,
  modeName: "tag" | "agent",
): string {
  if (modeName === "agent") {
    return context.prompt || `Repository: ${context.repository}`;
  }

  // Tag mode
  const tagPrompt =
    process.env.USE_SIMPLE_PROMPT === "true"
      ? generateSimplePrompt(context, githubData, useCommitSigning)
      : generateDefaultPrompt(context, githubData, useCommitSigning);

  if (context.githubContext?.inputs?.prompt) {
    return (
      tagPrompt.trimEnd() +
      `

<custom_instructions>
${context.githubContext.inputs.prompt}
</custom_instructions>`
    );
  }

  return tagPrompt;
}

/**
 * Extracts the user's request from the prepared context and GitHub data.
 *
 * This is used to send the user's actual command/request as a separate
 * content block, enabling slash command processing in the CLI.
 *
 * @param context - The prepared context containing event data and trigger phrase
 * @param githubData - The fetched GitHub data containing issue/PR body content
 * @returns The extracted user request text (e.g., "/review-pr" or "fix this bug"),
 *          or null for assigned/labeled events without an explicit trigger in the body,
 *          and when the workflow provides the prompt
 *
 * @example
 * // Comment event: "@pi /review-pr" -> returns "/review-pr"
 * // Issue body with "@pi fix this" -> returns "fix this"
 * // Issue assigned without @pi in body -> returns null
 */
function extractUserRequestFromContext(
  context: PreparedContext,
  githubData: FetchDataResult,
): string | null {
  const { eventData, triggerPhrase } = context;

  // With a workflow prompt (track_progress), the workflow author sets the
  // task; a slash command in a PR description or comment must not replace it.
  if (context.githubContext?.inputs?.prompt) {
    return null;
  }

  // For comment events, extract from comment body
  if (isCommentEvent(eventData) && eventData.commentBody) {
    return extractUserRequest(eventData.commentBody, triggerPhrase);
  }

  // For issue/PR events triggered by body content, extract from the body
  if (githubData.contextData?.body) {
    const request = extractUserRequest(
      githubData.contextData.body,
      triggerPhrase,
    );
    if (request) {
      return request;
    }
  }

  // For assigned/labeled events without explicit trigger in body,
  // return null to indicate the full context should be used
  return null;
}

/**
 * The prompt for tag mode, and the trigger comment's request on its own, for
 * the Runner to expand a slash command in it (e.g. "@pi /skill:review-pr").
 */
export function createPrompt(
  commentId: number,
  baseBranch: string | undefined,
  agentBranch: string | undefined,
  githubData: FetchDataResult,
  context: ParsedGitHubContext,
  githubTokenSource?: GitHubTokenSource,
): { prompt: string; userRequest?: string } {
  const preparedContext: PreparedContext = {
    ...prepareContext(context, commentId.toString(), baseBranch, agentBranch),
    githubTokenSource,
  };

  const prompt = generatePrompt(
    preparedContext,
    githubData,
    context.inputs.useCommitSigning,
    "tag",
  );
  console.log("===== FINAL PROMPT =====");
  console.log(prompt);
  console.log("=======================");

  const userRequest =
    extractUserRequestFromContext(preparedContext, githubData) ?? undefined;
  if (userRequest) {
    console.log("===== USER REQUEST =====");
    console.log(userRequest);
    console.log("========================");
  }
  return { prompt, userRequest };
}
