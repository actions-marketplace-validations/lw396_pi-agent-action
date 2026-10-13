import type { FetchDataResult } from "../github/data/fetcher";
import {
  formatContext,
  formatBody,
  formatComments,
  formatReviewComments,
  formatChangedFilesWithSHA,
} from "../github/data/formatter";
import type { EventData, PreparedContext } from "./types";

/** The only push command tag mode permits (see src/modes/tag). */
export function gitPushWrapper(): string {
  return `${process.env.GITHUB_ACTION_PATH}/scripts/git-push.sh`;
}

type CommentEventData = Extract<
  EventData,
  {
    eventName:
      | "issue_comment"
      | "pull_request_review_comment"
      | "pull_request_review";
  }
>;

/** Whether a comment or review triggered the run, carrying the request. */
export function isCommentEvent(
  eventData: EventData,
): eventData is CommentEventData {
  return (
    eventData.eventName === "issue_comment" ||
    eventData.eventName === "pull_request_review_comment" ||
    eventData.eventName === "pull_request_review"
  );
}

/** The fetched GitHub data as the text blocks both tag-mode prompts embed. */
export function formatGitHubData(githubData: FetchDataResult, isPR: boolean) {
  const {
    contextData,
    comments,
    changedFilesWithSHA,
    reviewData,
    imageUrlMap,
  } = githubData;
  return {
    formattedContext: formatContext(contextData, isPR),
    formattedBody: contextData?.body
      ? formatBody(contextData.body, imageUrlMap)
      : "No description provided",
    formattedComments: formatComments(comments, imageUrlMap),
    formattedReviewComments: isPR
      ? formatReviewComments(reviewData, imageUrlMap)
      : "",
    formattedChangedFiles: isPR
      ? formatChangedFilesWithSHA(changedFilesWithSHA)
      : "",
    hasImages: Boolean(imageUrlMap && imageUrlMap.size > 0),
  };
}

/** The Co-authored-by trailer for the trigger user, or "" when unknown. */
export function coAuthorTrailer(
  githubData: FetchDataResult,
  context: PreparedContext,
): string {
  const triggerName = githubData.triggerDisplayName ?? context.triggerUsername;
  const triggerEmail =
    context.triggerUserId && context.triggerUsername
      ? `${context.triggerUserId}+${context.triggerUsername}@users.noreply.github.com`
      : context.triggerUsername
        ? `${context.triggerUsername}@users.noreply.github.com`
        : undefined;
  return triggerName && triggerName !== "Unknown" && triggerEmail
    ? `Co-authored-by: ${triggerName} <${triggerEmail}>`
    : "";
}
