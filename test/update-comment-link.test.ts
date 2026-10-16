import { describe, expect, test } from "bun:test";
import {
  updateCommentLink,
  type UpdateCommentLinkParams,
} from "../src/entrypoints/update-comment-link";
import {
  mockIssueCommentContext,
  mockPullRequestReviewCommentContext,
} from "./mockContext";

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

/** An octokit whose issue comment 7 has `body`; records every update. */
function issueCommentOctokit(body: string) {
  const updatedBodies: string[] = [];
  const rest: any = {
    pulls: {
      getReviewComment: async () => {
        throw notFound();
      },
      updateReviewComment: async () => {
        throw notFound();
      },
    },
    issues: {
      getComment: async () => ({ data: { id: 7, body } }),
      updateComment: async ({ body }: { body: string }) => {
        updatedBodies.push(body);
        return { data: { id: 7, html_url: "", updated_at: "" } };
      },
    },
  };
  // updateComment takes octokit.rest, and Octokit exposes .rest on it too.
  rest.rest = rest;
  return { octokit: { rest } as any, updatedBodies };
}

async function finalBody(
  currentBody: string,
  params: Partial<UpdateCommentLinkParams>,
): Promise<string> {
  const { octokit, updatedBodies } = issueCommentOctokit(currentBody);
  await updateCommentLink({
    commentId: 7,
    githubToken: "test-token",
    baseBranch: "main",
    triggerUsername: "trigger-user",
    context: mockIssueCommentContext,
    octokit,
    agentSuccess: true,
    prepareSuccess: true,
    useCommitSigning: false,
    ...params,
  });
  expect(updatedBodies).toHaveLength(1);
  return updatedBodies[0]!;
}

describe("updateCommentLink", () => {
  test("updates the issue comment created in place of a review comment reply", async () => {
    const { octokit, updatedBodies } = issueCommentOctokit(
      'pi is working… <img src="spinner">',
    );

    await updateCommentLink({
      commentId: 7,
      githubToken: "test-token",
      baseBranch: "main",
      context: mockPullRequestReviewCommentContext,
      octokit,
      agentSuccess: true,
      prepareSuccess: true,
      useCommitSigning: false,
    });

    expect(updatedBodies).toHaveLength(1);
    expect(updatedBodies[0]).not.toContain("spinner");
  });

  test("reports that the run ended when the session succeeded", async () => {
    const body = await finalBody(
      "pi is working…\n\n- [ ] Run the integration tests (blocked)",
      { agentSuccess: true },
    );

    expect(body).toStartWith("**Pi's run for @trigger-user ended**");
    expect(body).toEndWith("---\n- [ ] Run the integration tests (blocked)");
  });

  test("shows an error when the session failed, keeping what the model posted", async () => {
    const body = await finalBody(
      "pi is working…\n\nRead the issue; starting on the parser.",
      { agentSuccess: false },
    );

    expect(body).toStartWith("**pi encountered an error**");
    expect(body).not.toContain("ended");
    expect(body).toEndWith("---\nRead the issue; starting on the parser.");
  });

  test("shows the redacted prepare error when prepare failed", async () => {
    const token = `ghs_${"a".repeat(36)}`;
    const body = await finalBody("pi is working…", {
      agentSuccess: false,
      prepareSuccess: false,
      prepareError: `git push https://x-access-token:${token}@github.com/o/r failed`,
    });

    expect(body).toStartWith("**pi encountered an error**");
    expect(body).toContain("```\ngit push https://x-access-token:");
    expect(body).not.toContain(token);
    expect(body).not.toContain("ended");
  });
});
