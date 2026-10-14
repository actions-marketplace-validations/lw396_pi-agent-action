# FAQ

## Triggering

### Why doesn't `@pi` in a comment posted by my workflow start the action?

Events created with a workflow's `GITHUB_TOKEN` do not start other workflows; GitHub does this to prevent loops. Post the comment with a GitHub App token or a personal access token instead.

### Why does the action say I don't have permission?

Only users with write access to the repository can trigger it. To let bots trigger it, list them in `allowed_bots`. `allowed_non_write_users` lets other users in, but read [Bash isolation](./security.md#bash-isolation-allowed_non_write_users) first.

### Why doesn't `@pi-bot` trigger it?

The trigger phrase must be a whole word, preceded by whitespace and followed by whitespace or punctuation. `@pi,` and `@pi!` work; `@pi-bot` and `email@pi` do not. Set `trigger_phrase` to use another phrase.

### Can I keep using `@claude`?

Yes: `trigger_phrase: "@claude"`, and `label_trigger: claude` and `branch_prefix: claude/` if you want those too.

### Why can't I assign the bot to an issue in my organization's private repository?

Private organization repositories only accept assignees from the organization. Use `label_trigger` instead, or set `assignee_trigger` to a user account your organization owns.

## Authentication

### Why do I get an OIDC error?

Without `github_token`, the action authenticates as the pi-agent-action app by exchanging the workflow's OIDC token, and the job needs:

```yaml
permissions:
  id-token: write
```

Then [install the app](https://github.com/apps/pi-agent-action) on the repository. If you'd rather not use the app, set `github_token`; see [GitHub authentication](../README.md#github-authentication).

### Why are comments posted as `github-actions[bot]` instead of `pi-agent-action[bot]`?

You set `github_token: ${{ secrets.GITHUB_TOKEN }}`, so the action acts as the workflow. Remove `github_token` and grant `id-token: write` to act as the app, or pass your own app's token.

### Why don't the agent's pushes start my CI?

Pushes made with the workflow's `GITHUB_TOKEN` do not start workflows. Use the pi-agent-action app or your own GitHub App.

## What the agent can and cannot do

### Why does the agent say it can't run my command?

Tool calls other than reads need a rule in `allowed_tools`. Add the command's prefix, e.g. `Bash(npm test:*)`. Commands joined with `&&`, `;` or `|` are refused when a `Bash(...)` rule decides them, so allow each command and let the agent run them separately. See [Letting the agent run commands](./configuration.md#letting-the-agent-run-commands).

### Why won't the agent rebase, merge or force-push?

It only creates commits and pushes them to the branch it works on: the pull request's branch, or a branch it created. The system prompt tells it to decline other git operations even when `allowed_tools` would allow them. Rebase or merge yourself.

### Why doesn't the agent open a pull request?

It pushes a branch and links a prefilled "Create a PR" page in its comment, so you decide whether to open it and branch protection rules still apply.

### Why can't it approve or request changes on a pull request?

The action never submits reviews, so an automated run cannot approve a pull request. It can leave inline comments when `allowed_tools` includes `mcp__github_inline_comment__create_inline_comment`.

### Why won't it change files under `.github/workflows/`?

The pi-agent-action app has no Workflows permission, so GitHub rejects pushes that change workflows. This is deliberate: a prompt injection could otherwise rewrite your CI.

### Can it see CI results?

Yes, with `actions: read`. See [Reading CI results](./configuration.md#reading-ci-results).

### Why does it update one comment instead of posting several?

Progress and the answer go into a single tracking comment, to keep the thread readable. With `use_sticky_comment: true`, runs started by `pull_request` events also reuse the action's earlier comment on that pull request.

### Can it work across repositories?

No. The app token only covers the repository the workflow runs in.

### Can I add my own MCP servers?

Not yet. Only the action's own GitHub servers are available; see [MCP servers](./configuration.md#mcp-servers).

## Branches and history

### Why did it create a new branch on a closed pull request?

It cannot push to a closed pull request's branch, so it creates a new one, as it does for issues. On an open pull request it pushes to the pull request's branch.

### Why is the git history shallow?

`actions/checkout` fetches one commit by default. On pull requests the action deepens the fetch to cover the pull request's commits. For full history, check out with `fetch-depth: 0`:

```yaml
- uses: actions/checkout@v6
  with:
    fetch-depth: 0
```

## Debugging

### How do I see what the agent did?

- The Job Summary always shows the run summary: how the session ended, how many model responses and tool calls it made, and tokens and cost. See [What does the run summary show?](#what-does-the-run-summary-show).
- The Job Summary also shows the pi Agent Report, with the agent's text and every tool call, when `display_report: true`.
- `export_session: true` exports the redacted session as pi's JSONL and an offline HTML page, for an upload step. See [Exporting the session](usage.md#exporting-the-session).
- `show_full_output: true`, or re-running the job with debug logging, prints every pi event in the job log. Tool results can contain sensitive data; use it on private repositories only.
- The `execution_file` output is the full record of the run, with token usage and cost.

### What does the run summary show?

Every run that reaches the agent writes a short "pi run summary" to the Job Summary of the workflow run, with no input to set. Failed runs get one too. It answers:

- **How the session ended**: completed, stopped at the output limit, model error, aborted, no model response, no structured result (`json_schema`), or Runner error. This is how the pi session ended, not whether the task was done: the action does not judge the agent's work, and does not read the model's claims or checkboxes.
- **How long it ran**, and **how many model responses and tool calls** it made: calls attempted, calls that ran and failed, and calls the `allowed_tools` and `disallowed_tools` rules denied. The counts come from the Runner's session events, each call counted once.
- **Tokens**: input, output, cache read, cache write and their total, summed over the model responses as pi's session stats count them. Input does not include cached tokens. pi records cache usage a provider does not report as 0, so a 0 for cache read or write can mean either.
- **Estimated cost**, priced from the pi SDK's model catalog. It can differ from your bill, especially with a custom endpoint (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`). For a model the catalog has no prices for, the cost is `unavailable`.

A value the run could not measure shows as `unavailable`. When the Runner stops before the session starts, for example because `model` names an unknown model, the summary says that statistics are unavailable.

It does not show what the agent did: no prompt, model text or reasoning, file contents, tool arguments, commands, command output or error messages. The summary is built only from numbers and fixed labels, so it is safe to publish on a public repository without relying on redaction. For more:

- `display_report: true` adds the pi Agent Report below it, with the agent's text, each tool call and its result. It contains model-written content; enable it only for trusted input.
- The `execution_file` output is the full record of the session. It can contain sensitive content and is not uploaded or published by the action.

### Why do some values in comments show as `[REDACTED]`?

The action redacts known token formats and every environment value of 16 characters or more that is not on its allowlist. To show a long non-secret value, put it in `prompt` instead of `env:`.

## Getting help

Search the [issues](https://github.com/lw396/pi-agent-action/issues) or open a new one with your workflow file and the job log. Report security problems privately, as described in [SECURITY.md](../.github/SECURITY.md).
