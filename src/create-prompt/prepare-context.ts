import {
  isIssuesEvent,
  isIssueCommentEvent,
  isPullRequestReviewEvent,
  isPullRequestReviewCommentEvent,
} from "../github/context";
import type { ParsedGitHubContext } from "../github/context";
import type { CommonFields, EventData, PreparedContext } from "./types";

/**
 * The event data the tag-mode prompts need, validated per event type, from
 * the parsed GitHub context and the branches the action prepared.
 */
export function prepareContext(
  context: ParsedGitHubContext,
  trackingCommentId: string,
  baseBranch?: string,
  agentBranch?: string,
): PreparedContext {
  const repository = context.repository.full_name;
  const eventName = context.eventName;
  const eventAction = context.eventAction;
  const triggerPhrase = context.inputs.triggerPhrase || "@pi";
  const assigneeTrigger = context.inputs.assigneeTrigger;
  const labelTrigger = context.inputs.labelTrigger;
  const prompt = context.inputs.prompt;
  const isPR = context.isPR;

  // Get PR/Issue number from entityNumber
  const prNumber = isPR ? context.entityNumber.toString() : undefined;
  const issueNumber = !isPR ? context.entityNumber.toString() : undefined;

  // Extract trigger username and comment data based on event type
  let triggerUsername: string | undefined;
  let triggerUserId: number | undefined;
  let commentId: string | undefined;
  let commentBody: string | undefined;

  if (isIssueCommentEvent(context)) {
    commentId = context.payload.comment.id.toString();
    commentBody = context.payload.comment.body;
    triggerUsername = context.payload.comment.user.login;
    triggerUserId = context.payload.comment.user.id;
  } else if (isPullRequestReviewEvent(context)) {
    commentBody = context.payload.review.body ?? "";
    triggerUsername = context.payload.review.user.login;
    triggerUserId = context.payload.review.user.id;
  } else if (isPullRequestReviewCommentEvent(context)) {
    commentId = context.payload.comment.id.toString();
    commentBody = context.payload.comment.body;
    triggerUsername = context.payload.comment.user.login;
    triggerUserId = context.payload.comment.user.id;
  } else if (isIssuesEvent(context)) {
    // The user who opened, assigned or labeled the issue, not its author.
    triggerUsername = context.payload.sender.login;
    triggerUserId = context.payload.sender.id;
  }

  // Create infrastructure fields object
  const commonFields: CommonFields = {
    repository,
    trackingCommentId,
    triggerPhrase,
    ...(triggerUsername && { triggerUsername }),
    ...(triggerUserId && { triggerUserId }),
    ...(prompt && { prompt }),
    ...(agentBranch && { agentBranch }),
  };

  // Parse event-specific data based on event type
  let eventData: EventData;

  switch (eventName) {
    case "pull_request_review_comment":
      if (!prNumber) {
        throw new Error(
          "PR_NUMBER is required for pull_request_review_comment event",
        );
      }
      if (!isPR) {
        throw new Error(
          "IS_PR must be true for pull_request_review_comment event",
        );
      }
      if (!commentBody) {
        throw new Error(
          "COMMENT_BODY is required for pull_request_review_comment event",
        );
      }
      eventData = {
        eventName: "pull_request_review_comment",
        isPR: true,
        prNumber,
        ...(commentId && { commentId }),
        commentBody,
        ...(agentBranch && { agentBranch }),
        ...(baseBranch && { baseBranch }),
      };
      break;

    case "pull_request_review":
      if (!prNumber) {
        throw new Error("PR_NUMBER is required for pull_request_review event");
      }
      if (!isPR) {
        throw new Error("IS_PR must be true for pull_request_review event");
      }
      eventData = {
        eventName: "pull_request_review",
        isPR: true,
        prNumber,
        commentBody,
        ...(agentBranch && { agentBranch }),
        ...(baseBranch && { baseBranch }),
      };
      break;

    case "issue_comment":
      if (!commentId) {
        throw new Error("COMMENT_ID is required for issue_comment event");
      }
      if (!commentBody) {
        throw new Error("COMMENT_BODY is required for issue_comment event");
      }
      if (isPR) {
        if (!prNumber) {
          throw new Error(
            "PR_NUMBER is required for issue_comment event for PRs",
          );
        }

        eventData = {
          eventName: "issue_comment",
          commentId,
          isPR: true,
          prNumber,
          commentBody,
          ...(agentBranch && { agentBranch }),
          ...(baseBranch && { baseBranch }),
        };
        break;
      } else if (!agentBranch) {
        throw new Error("AGENT_BRANCH is required for issue_comment event");
      } else if (!baseBranch) {
        throw new Error("BASE_BRANCH is required for issue_comment event");
      } else if (!issueNumber) {
        throw new Error(
          "ISSUE_NUMBER is required for issue_comment event for issues",
        );
      }

      eventData = {
        eventName: "issue_comment",
        commentId,
        isPR: false,
        agentBranch: agentBranch,
        baseBranch,
        issueNumber,
        commentBody,
      };
      break;

    case "issues":
      if (!eventAction) {
        throw new Error("GITHUB_EVENT_ACTION is required for issues event");
      }
      if (!issueNumber) {
        throw new Error("ISSUE_NUMBER is required for issues event");
      }
      if (isPR) {
        throw new Error("IS_PR must be false for issues event");
      }
      if (!baseBranch) {
        throw new Error("BASE_BRANCH is required for issues event");
      }
      if (!agentBranch) {
        throw new Error("AGENT_BRANCH is required for issues event");
      }

      if (eventAction === "assigned") {
        if (!assigneeTrigger && !prompt) {
          throw new Error(
            "ASSIGNEE_TRIGGER is required for issue assigned event",
          );
        }
        eventData = {
          eventName: "issues",
          eventAction: "assigned",
          isPR: false,
          issueNumber,
          baseBranch,
          agentBranch,
          ...(assigneeTrigger && { assigneeTrigger }),
        };
      } else if (eventAction === "labeled") {
        if (!labelTrigger) {
          throw new Error("LABEL_TRIGGER is required for issue labeled event");
        }
        eventData = {
          eventName: "issues",
          eventAction: "labeled",
          isPR: false,
          issueNumber,
          baseBranch,
          agentBranch,
          labelTrigger,
        };
      } else if (eventAction === "opened") {
        eventData = {
          eventName: "issues",
          eventAction: "opened",
          isPR: false,
          issueNumber,
          baseBranch,
          agentBranch,
        };
      } else {
        throw new Error(`Unsupported issue action: ${eventAction}`);
      }
      break;

    case "pull_request":
      if (!prNumber) {
        throw new Error("PR_NUMBER is required for pull_request event");
      }
      if (!isPR) {
        throw new Error("IS_PR must be true for pull_request event");
      }
      eventData = {
        eventName: "pull_request",
        eventAction: eventAction,
        isPR: true,
        prNumber,
        ...(agentBranch && { agentBranch }),
        ...(baseBranch && { baseBranch }),
      };
      break;

    default:
      throw new Error(`Unsupported event type: ${eventName}`);
  }

  return {
    ...commonFields,
    eventData,
    githubContext: context,
  };
}

export function getEventTypeAndContext(envVars: PreparedContext): {
  eventType: string;
  triggerContext: string;
} {
  const eventData = envVars.eventData;

  switch (eventData.eventName) {
    case "pull_request_review_comment":
      return {
        eventType: "REVIEW_COMMENT",
        triggerContext: `PR review comment with '${envVars.triggerPhrase}'`,
      };

    case "pull_request_review":
      return {
        eventType: "PR_REVIEW",
        triggerContext: `PR review with '${envVars.triggerPhrase}'`,
      };

    case "issue_comment":
      return {
        eventType: "GENERAL_COMMENT",
        triggerContext: `issue comment with '${envVars.triggerPhrase}'`,
      };

    case "issues":
      if (eventData.eventAction === "opened") {
        return {
          eventType: "ISSUE_CREATED",
          triggerContext: `new issue with '${envVars.triggerPhrase}' in body`,
        };
      } else if (eventData.eventAction === "labeled") {
        return {
          eventType: "ISSUE_LABELED",
          triggerContext: `issue labeled with '${eventData.labelTrigger}'`,
        };
      }
      return {
        eventType: "ISSUE_ASSIGNED",
        triggerContext: eventData.assigneeTrigger
          ? `issue assigned to '${eventData.assigneeTrigger}'`
          : `issue assigned event`,
      };

    case "pull_request":
    case "pull_request_target":
      return {
        eventType: "PULL_REQUEST",
        triggerContext: eventData.eventAction
          ? `pull request ${eventData.eventAction}`
          : `pull request event`,
      };

    default:
      throw new Error(`Unexpected event type`);
  }
}
