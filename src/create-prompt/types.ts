import type { GitHubContext } from "../github/context";
import type { GitHubTokenSource } from "../github/token";

export type CommonFields = {
  repository: string;
  trackingCommentId: string;
  triggerPhrase: string;
  triggerUsername?: string;
  triggerUserId?: number;
  prompt?: string;
  agentBranch?: string;
};

type PullRequestReviewCommentEvent = {
  eventName: "pull_request_review_comment";
  isPR: true;
  prNumber: string;
  commentId?: string; // May be present for review comments
  commentBody: string;
  agentBranch?: string;
  baseBranch?: string;
};

type PullRequestReviewEvent = {
  eventName: "pull_request_review";
  isPR: true;
  prNumber: string;
  commentBody?: string; // May be absent for approvals without comments
  agentBranch?: string;
  baseBranch?: string;
};

type IssueCommentEvent = {
  eventName: "issue_comment";
  commentId: string;
  issueNumber: string;
  isPR: false;
  baseBranch: string;
  agentBranch: string;
  commentBody: string;
};

// Not actually a real github event, since issue comments and PR coments are both sent as issue_comment
type PullRequestCommentEvent = {
  eventName: "issue_comment";
  commentId: string;
  prNumber: string;
  isPR: true;
  commentBody: string;
  agentBranch?: string;
  baseBranch?: string;
};

type IssueOpenedEvent = {
  eventName: "issues";
  eventAction: "opened";
  isPR: false;
  issueNumber: string;
  baseBranch: string;
  agentBranch: string;
};

type IssueAssignedEvent = {
  eventName: "issues";
  eventAction: "assigned";
  isPR: false;
  issueNumber: string;
  baseBranch: string;
  agentBranch: string;
  assigneeTrigger?: string;
};

type IssueLabeledEvent = {
  eventName: "issues";
  eventAction: "labeled";
  isPR: false;
  issueNumber: string;
  baseBranch: string;
  agentBranch: string;
  labelTrigger: string;
};

type PullRequestBaseEvent = {
  eventAction?: string; // opened, synchronize, etc.
  isPR: true;
  prNumber: string;
  agentBranch?: string;
  baseBranch?: string;
};

type PullRequestEvent = PullRequestBaseEvent & {
  eventName: "pull_request";
};

type PullRequestTargetEvent = PullRequestBaseEvent & {
  eventName: "pull_request_target";
};

// Union type for all possible event types
export type EventData =
  | PullRequestReviewCommentEvent
  | PullRequestReviewEvent
  | PullRequestCommentEvent
  | IssueCommentEvent
  | IssueOpenedEvent
  | IssueAssignedEvent
  | IssueLabeledEvent
  | PullRequestEvent
  | PullRequestTargetEvent;

// Combined type with separate eventData field
export type PreparedContext = CommonFields & {
  eventData: EventData;
  githubContext?: GitHubContext;
  /** Unset when unknown; the prompt then assumes nothing about the token. */
  githubTokenSource?: GitHubTokenSource;
  /**
   * A random id the default prompt puts on the opening and closing tag of each
   * block of GitHub content, so text inside a block cannot close it and open a
   * fake one. createPrompt sets a new one per run; unset, tags carry no id.
   */
  contentTagId?: string;
  /**
   * The WIP commit at the tip of the checked-out branch, when the run resumes
   * unfinished work an earlier failed run saved (operations/wip.ts).
   */
  resumedWipCommit?: string;
};
