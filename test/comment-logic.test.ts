import { describe, it, expect } from "bun:test";
import {
  updateCommentBody,
  type CommentUpdateInput,
} from "../src/github/operations/comment-logic";

describe("updateCommentBody", () => {
  const baseInput = {
    currentBody: "Initial comment body",
    actionFailed: false,
    executionDetails: null,
    jobUrl: "https://github.com/owner/repo/actions/runs/123",
    branchName: undefined,
    triggerUsername: undefined,
  };

  describe("run end header", () => {
    it("says the run ended, not that the task is done, after an implementation", () => {
      const result = updateCommentBody({
        ...baseInput,
        currentBody:
          "pi is working… <img src='spinner.gif' />\n\n### Changes\n- [x] Add parser\n- [x] Push branch\n\n[View job run](https://github.com/owner/repo/actions/runs/123)",
        executionDetails: { duration_ms: 74000 },
        triggerUsername: "trigger-user",
        branchName: "pi/issue-1-20240101-1200",
        prLink:
          "\n[Create a PR](https://github.com/owner/repo/compare/main...pi/issue-1-20240101-1200)",
      });

      expect(result).toStartWith(
        "**Pi's run for @trigger-user ended after 1m 14s** —— [View job](https://github.com/owner/repo/actions/runs/123) • [`pi/issue-1-20240101-1200`](https://github.com/owner/repo/tree/pi/issue-1-20240101-1200) • [Create PR ➔](https://github.com/owner/repo/compare/main...pi/issue-1-20240101-1200)\n\n---\n### Changes",
      );
      expect(result).not.toMatch(/finished|task/i);
    });

    it("uses the same header for an answer or review with no branch", () => {
      const review =
        "### Review\n\n- `src/a.ts:12` misses the null case.\n\nNo changes were made.";
      const result = updateCommentBody({
        ...baseInput,
        currentBody: `pi is working… <img src='spinner.gif' />\n\n${review}`,
        executionDetails: { duration_ms: 9000 },
        triggerUsername: "reviewer",
      });

      expect(result).toBe(
        `**Pi's run for @reviewer ended after 9s** —— [View job](https://github.com/owner/repo/actions/runs/123)\n\n---\n${review}`,
      );
    });

    it("keeps a reported blocker and open items as the model wrote them", () => {
      const report = [
        "### Incomplete: blocked",
        "",
        "- [x] Add the endpoint",
        "- [ ] Run the integration tests",
        "",
        "`Bash(npm test:*)` is not in allowed_tools, so the tests did not run. The independent review was not run either.",
      ].join("\n");
      const result = updateCommentBody({
        ...baseInput,
        currentBody: `pi is working…\n\n${report}`,
        triggerUsername: "trigger-user",
      });

      expect(result).toStartWith("**Pi's run for @trigger-user ended**");
      expect(result).toEndWith(`---\n${report}`);
      expect(result).not.toContain("encountered an error");
    });
  });

  describe("unfinished work note", () => {
    it("puts the note under the failure header, above the model's report", () => {
      const note =
        "Unfinished work was saved to `pi/issue-1-x` in [abc1234](https://github.com/owner/repo/commit/abc1234).";
      const result = updateCommentBody({
        ...baseInput,
        currentBody: "pi is working…\n\n### Progress\n- [ ] Step",
        actionFailed: true,
        wipNote: note,
      });

      expect(result).toBe(
        `**pi encountered an error** —— [View job](https://github.com/owner/repo/actions/runs/123)\n\n${note}\n\n---\n### Progress\n- [ ] Step`,
      );
    });
  });

  describe("spinner left by the model", () => {
    const spinner =
      '<img src="https://raw.githubusercontent.com/lw396/pi-agent-action/main/assets/spinner.gif" width="14px" height="14px" style="vertical-align: middle; margin-left: 4px;" />';

    it("removes a spinner on its own line so the checklist under it renders", () => {
      // An HTML line swallows the lines after it up to a blank line, so GitHub
      // shows this checklist as plain text until the spinner is gone.
      const result = updateCommentBody({
        ...baseInput,
        currentBody: `### Implemented, committing\n${spinner}\n- [x] Add the endpoint\n- [ ] Push the branch`,
        actionFailed: true,
        executionDetails: { duration_ms: 30000 },
      });

      expect(result).toEndWith(
        "---\n### Implemented, committing\n- [x] Add the endpoint\n- [ ] Push the branch",
      );
    });

    it("keeps images that are not this repository's spinner", () => {
      const other =
        '<img src="https://example.com/not-spinner.gif" width="14" />';
      const lookalike =
        '<img src="https://example.com/loading-spinner.gif.png" />';
      const result = updateCommentBody({
        ...baseInput,
        currentBody: `Intro ${other}\n${lookalike}\nAnswer.`,
        triggerUsername: "trigger-user",
      });

      expect(result).toEndWith(`---\nIntro ${other}\n${lookalike}\nAnswer.`);
    });

    it("removes a spinner at the end of a heading after a normal end", () => {
      const result = updateCommentBody({
        ...baseInput,
        currentBody: `### Working ${spinner}\n\nAnswer.`,
        triggerUsername: "trigger-user",
      });

      expect(result).toEndWith("---\n### Working\n\nAnswer.");
    });
  });

  describe("working message replacement", () => {
    it("includes success message header with duration", () => {
      const input = {
        ...baseInput,
        currentBody: "pi is working…",
        executionDetails: { duration_ms: 74000 }, // 1m 14s
        triggerUsername: "trigger-user",
      };

      const result = updateCommentBody(input);
      expect(result).toContain(
        "**Pi's run for @trigger-user ended after 1m 14s**",
      );
      expect(result).not.toContain("pi is working");
    });

    it("includes error message header with duration", () => {
      const input = {
        ...baseInput,
        currentBody: "pi is working...",
        actionFailed: true,
        executionDetails: { duration_ms: 45000 }, // 45s
      };

      const result = updateCommentBody(input);
      expect(result).toContain("**pi encountered an error after 45s**");
    });

    it("includes error details when provided", () => {
      const input = {
        ...baseInput,
        currentBody: "pi is working...",
        actionFailed: true,
        executionDetails: { duration_ms: 45000 },
        errorDetails: "Failed to fetch issue data",
      };

      const result = updateCommentBody(input);
      expect(result).toContain("**pi encountered an error after 45s**");
      expect(result).toContain("[View job]");
      expect(result).toContain("```\nFailed to fetch issue data\n```");
      // Ensure error details come after the header/links
      const errorIndex = result.indexOf("```");
      const headerIndex = result.indexOf("**pi encountered an error");
      expect(errorIndex).toBeGreaterThan(headerIndex);
    });

    it("handles username extraction from content when not provided", () => {
      const input = {
        ...baseInput,
        currentBody:
          "pi is working… <img src='spinner.gif' />\n\nI'll work on this task @testuser",
      };

      const result = updateCommentBody(input);
      expect(result).toContain("**Pi's run for @testuser ended**");
    });
  });

  describe("job link", () => {
    it("includes job link in header", () => {
      const input = {
        ...baseInput,
        currentBody: "Some comment",
      };

      const result = updateCommentBody(input);
      expect(result).toContain(`—— [View job](${baseInput.jobUrl})`);
    });

    it("always includes job link in header, even if present in body", () => {
      const input = {
        ...baseInput,
        currentBody: `Some comment with [View job run](${baseInput.jobUrl})`,
        triggerUsername: "testuser",
      };

      const result = updateCommentBody(input);
      // Check it's in the header with the new format
      expect(result).toContain(`—— [View job](${baseInput.jobUrl})`);
      // The old link in body is removed
      expect(result).not.toContain("View job run");
    });
  });

  describe("branch link", () => {
    it("adds branch name with link to header when provided", () => {
      const input = {
        ...baseInput,
        branchName: "claude/issue-123-20240101-1200",
      };

      const result = updateCommentBody(input);
      expect(result).toContain(
        "• [`claude/issue-123-20240101-1200`](https://github.com/owner/repo/tree/claude/issue-123-20240101-1200)",
      );
    });

    it("extracts branch name from branchLink if branchName not provided", () => {
      const input = {
        ...baseInput,
        branchLink:
          "\n[View branch](https://github.com/owner/repo/tree/branch-name)",
      };

      const result = updateCommentBody(input);
      expect(result).toContain(
        "• [`branch-name`](https://github.com/owner/repo/tree/branch-name)",
      );
    });

    it("removes old branch links from body", () => {
      const input = {
        ...baseInput,
        currentBody:
          "Some comment with [View branch](https://github.com/owner/repo/tree/branch-name)",
        branchName: "new-branch-name",
      };

      const result = updateCommentBody(input);
      expect(result).toContain(
        "• [`new-branch-name`](https://github.com/owner/repo/tree/new-branch-name)",
      );
      expect(result).not.toContain("View branch");
    });
  });

  describe("PR link", () => {
    it("adds PR link to header when provided", () => {
      const input = {
        ...baseInput,
        prLink: "\n[Create a PR](https://github.com/owner/repo/pr-url)",
      };

      const result = updateCommentBody(input);
      expect(result).toContain(
        "• [Create PR ➔](https://github.com/owner/repo/pr-url)",
      );
    });

    it("moves PR link from body to header", () => {
      const input = {
        ...baseInput,
        currentBody:
          "Some comment with [Create a PR](https://github.com/owner/repo/pr-url)",
      };

      const result = updateCommentBody(input);
      expect(result).toContain(
        "• [Create PR ➔](https://github.com/owner/repo/pr-url)",
      );
      // Original Create a PR link is removed from body
      expect(result).not.toContain("[Create a PR]");
    });

    it("handles both body and provided PR links", () => {
      const input = {
        ...baseInput,
        currentBody:
          "Some comment with [Create a PR](https://github.com/owner/repo/pr-url-from-body)",
        prLink:
          "\n[Create a PR](https://github.com/owner/repo/pr-url-provided)",
      };

      const result = updateCommentBody(input);
      // Prefers the link found in content over the provided one
      expect(result).toContain(
        "• [Create PR ➔](https://github.com/owner/repo/pr-url-from-body)",
      );
    });

    it("handles complex PR URLs with encoded characters", () => {
      const complexUrl =
        "https://github.com/owner/repo/compare/main...feature-branch?quick_pull=1&title=fix%3A%20important%20bug%20fix&body=Fixes%20%23123%0A%0A%23%23%20Description%0AThis%20PR%20fixes%20an%20important%20bug%20that%20was%20causing%20issues%20with%20the%20application.%0A%0AGenerated%20with%20%5BClaude%20Code%5D(https%3A%2F%2Fclaude.ai%2Fcode)";
      const input = {
        ...baseInput,
        currentBody: `Some comment with [Create a PR](${complexUrl})`,
      };

      const result = updateCommentBody(input);
      expect(result).toContain(`• [Create PR ➔](${complexUrl})`);
      // Original link should be removed from body
      expect(result).not.toContain("[Create a PR]");
    });

    it("handles PR links with encoded URLs containing parentheses", () => {
      const complexUrl =
        "https://github.com/owner/repo/compare/main...feature-branch?quick_pull=1&title=fix%3A%20bug%20fix&body=Generated%20with%20%5BClaude%20Code%5D(https%3A%2F%2Fclaude.ai%2Fcode)";
      const input = {
        ...baseInput,
        currentBody: `This PR was created.\n\n[Create a PR](${complexUrl})`,
      };

      const result = updateCommentBody(input);
      expect(result).toContain(`• [Create PR ➔](${complexUrl})`);
      // Original link should be removed from body completely
      expect(result).not.toContain("[Create a PR]");
      // Body content shouldn't have stray closing parens
      expect(result).toContain("This PR was created.");
      // Body part should be clean with no stray parens
      const bodyAfterSeparator = result.split("---")[1]?.trim();
      expect(bodyAfterSeparator).toBe("This PR was created.");
    });

    it("handles PR links with unencoded spaces and special characters", () => {
      const unEncodedUrl =
        "https://github.com/owner/repo/compare/main...feature-branch?quick_pull=1&title=fix: update welcome message&body=Generated with [Claude Code](https://claude.ai/code)";
      const expectedEncodedUrl =
        "https://github.com/owner/repo/compare/main...feature-branch?quick_pull=1&title=fix%3A+update+welcome+message&body=Generated+with+%5BClaude+Code%5D%28https%3A%2F%2Fclaude.ai%2Fcode%29";
      const input = {
        ...baseInput,
        currentBody: `This PR was created.\n\n[Create a PR](${unEncodedUrl})`,
      };

      const result = updateCommentBody(input);
      expect(result).toContain(`• [Create PR ➔](${expectedEncodedUrl})`);
      // Original link should be removed from body completely
      expect(result).not.toContain("[Create a PR]");
      // Body content should be preserved
      expect(result).toContain("This PR was created.");
    });

    it("falls back to prLink parameter when PR link in content cannot be encoded", () => {
      const invalidUrl = "not-a-valid-url-at-all";
      const fallbackPrUrl = "https://github.com/owner/repo/pull/123";
      const input = {
        ...baseInput,
        currentBody: `This PR was created.\n\n[Create a PR](${invalidUrl})`,
        prLink: `\n[Create a PR](${fallbackPrUrl})`,
      };

      const result = updateCommentBody(input);
      expect(result).toContain(`• [Create PR ➔](${fallbackPrUrl})`);
      // Original link with invalid URL should still be in body since encoding failed
      expect(result).toContain("[Create a PR](not-a-valid-url-at-all)");
      expect(result).toContain("This PR was created.");
    });
  });

  describe("execution details", () => {
    it("includes duration in header for success", () => {
      const input = {
        ...baseInput,
        executionDetails: {
          total_cost_usd: 0.13382595,
          duration_ms: 31033,
          duration_api_ms: 31034,
        },
        triggerUsername: "testuser",
      };

      const result = updateCommentBody(input);
      expect(result).toContain("**Pi's run for @testuser ended after 31s**");
    });

    it("formats duration in minutes and seconds in header", () => {
      const input = {
        ...baseInput,
        executionDetails: {
          duration_ms: 75000, // 1 minute 15 seconds
        },
        triggerUsername: "testuser",
      };

      const result = updateCommentBody(input);
      expect(result).toContain("**Pi's run for @testuser ended after 1m 15s**");
    });

    it("includes duration in error header", () => {
      const input = {
        ...baseInput,
        actionFailed: true,
        executionDetails: {
          duration_ms: 45000, // 45 seconds
        },
      };

      const result = updateCommentBody(input);
      expect(result).toContain("**pi encountered an error after 45s**");
    });

    it("handles missing duration gracefully", () => {
      const input = {
        ...baseInput,
        executionDetails: {
          total_cost_usd: 0.25,
        },
        triggerUsername: "testuser",
      };

      const result = updateCommentBody(input);
      expect(result).toContain("**Pi's run for @testuser ended**");
      expect(result).not.toContain(" after ");
    });
  });

  describe("combined updates", () => {
    it("combines all updates in correct order", () => {
      const input = {
        ...baseInput,
        currentBody:
          "pi is working…\n\n### Todo List:\n- [x] Read README.md\n- [x] Add disclaimer",
        actionFailed: false,
        branchName: "claude-branch-123",
        prLink: "\n[Create a PR](https://github.com/owner/repo/pr-url)",
        executionDetails: {
          total_cost_usd: 0.01,
          duration_ms: 65000, // 1 minute 5 seconds
        },
        triggerUsername: "trigger-user",
      };

      const result = updateCommentBody(input);

      // Check the header structure
      expect(result).toContain(
        "**Pi's run for @trigger-user ended after 1m 5s**",
      );
      expect(result).toContain("—— [View job]");
      expect(result).toContain(
        "• [`claude-branch-123`](https://github.com/owner/repo/tree/claude-branch-123)",
      );
      expect(result).toContain("• [Create PR ➔]");

      // Check order - header comes before separator with blank line
      const headerIndex = result.indexOf("**Pi's run for");
      const blankLineAndSeparatorPattern = /\n\n---\n/;
      expect(result).toMatch(blankLineAndSeparatorPattern);

      const separatorIndex = result.indexOf("---");
      const todoIndex = result.indexOf("### Todo List:");

      expect(headerIndex).toBeLessThan(separatorIndex);
      expect(separatorIndex).toBeLessThan(todoIndex);

      // Check content is preserved
      expect(result).toContain("### Todo List:");
      expect(result).toContain("- [x] Read README.md");
      expect(result).toContain("- [x] Add disclaimer");
    });

    it("handles PR link extraction from content", () => {
      const input = {
        ...baseInput,
        currentBody:
          "pi is working…\n\nI've made changes.\n[Create a PR](https://github.com/owner/repo/pr-url-in-content)\n\n@john-doe",
        branchName: "feature-branch",
        triggerUsername: "john-doe",
      };

      const result = updateCommentBody(input);

      // PR link should be moved to header
      expect(result).toContain(
        "• [Create PR ➔](https://github.com/owner/repo/pr-url-in-content)",
      );
      // Original link should be removed from body
      expect(result).not.toContain("[Create a PR]");
      // Username should come from argument, not extraction
      expect(result).toContain("**Pi's run for @john-doe ended**");
      // Content should be preserved
      expect(result).toContain("I've made changes.");
    });

    it("includes PR link for new branches (issues and closed PRs)", () => {
      const input = {
        ...baseInput,
        currentBody: "pi is working… <img src='spinner.gif' />",
        branchName: "claude/pr-456-20240101-1200",
        prLink:
          "\n[Create a PR](https://github.com/owner/repo/compare/main...claude/pr-456-20240101-1200)",
        triggerUsername: "jane-doe",
      };

      const result = updateCommentBody(input);

      // Should include the PR link in the formatted style
      expect(result).toContain(
        "• [Create PR ➔](https://github.com/owner/repo/compare/main...claude/pr-456-20240101-1200)",
      );
      expect(result).toContain("**Pi's run for @jane-doe ended**");
    });

    it("includes both branch link and PR link for new branches", () => {
      const input = {
        ...baseInput,
        currentBody: "pi is working…",
        branchName: "claude/issue-123-20240101-1200",
        branchLink:
          "\n[View branch](https://github.com/owner/repo/tree/claude/issue-123-20240101-1200)",
        prLink:
          "\n[Create a PR](https://github.com/owner/repo/compare/main...claude/issue-123-20240101-1200)",
      };

      const result = updateCommentBody(input);

      // Should include both links in formatted style
      expect(result).toContain(
        "• [`claude/issue-123-20240101-1200`](https://github.com/owner/repo/tree/claude/issue-123-20240101-1200)",
      );
      expect(result).toContain(
        "• [Create PR ➔](https://github.com/owner/repo/compare/main...claude/issue-123-20240101-1200)",
      );
    });

    it("should not show branch name when branch doesn't exist remotely", () => {
      const input: CommentUpdateInput = {
        currentBody: "@claude can you help with this?",
        actionFailed: false,
        executionDetails: { duration_ms: 90000 },
        jobUrl: "https://github.com/owner/repo/actions/runs/123",
        branchLink: "", // Empty branch link means branch doesn't exist remotely
        branchName: undefined, // Should be undefined when branchLink is empty
        triggerUsername: "claude",
        prLink: "",
      };

      const result = updateCommentBody(input);

      expect(result).toContain("Pi's run for @claude ended after 1m 30s");
      expect(result).toContain(
        "[View job](https://github.com/owner/repo/actions/runs/123)",
      );
      expect(result).not.toContain("claude/issue-123");
      expect(result).not.toContain("tree/claude/issue-123");
    });
  });
});
