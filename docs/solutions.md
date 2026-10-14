# Solutions

Ready-to-use workflows for common jobs. Each one runs in agent mode (it sets `prompt`), so it starts on its own event instead of waiting for `@pi`. Copy a file from [`examples/`](../examples), replace `<model-id>` and the provider key, and adjust the prompt.

| Job                                    | Example                                                                        | Event                       |
| -------------------------------------- | ------------------------------------------------------------------------------ | --------------------------- |
| Answer `@pi` on issues and PRs         | [`pi.yml`](../examples/pi.yml)                                                 | Comments, issues            |
| Review every pull request              | [`pr-review-comprehensive.yml`](../examples/pr-review-comprehensive.yml)       | `pull_request`              |
| Explain a new PR with diagrams (skill) | [`pr-explain-show-me.yml`](../examples/pr-explain-show-me.yml)                 | `pull_request: opened`      |
| Review only some paths                 | [`pr-review-filtered-paths.yml`](../examples/pr-review-filtered-paths.yml)     | `pull_request` with `paths` |
| Review PRs from some authors           | [`pr-review-filtered-authors.yml`](../examples/pr-review-filtered-authors.yml) | `pull_request`              |
| Label new issues                       | [`issue-triage.yml`](../examples/issue-triage.yml)                             | `issues: opened`            |
| Find duplicate issues                  | [`issue-deduplication.yml`](../examples/issue-deduplication.yml)               | `issues: opened`            |
| Fix failing CI on a pull request       | [`ci-failure-auto-fix.yml`](../examples/ci-failure-auto-fix.yml)               | `workflow_run`              |
| Retry flaky tests (structured output)  | [`test-failure-analysis.yml`](../examples/test-failure-analysis.yml)           | `workflow_run`              |
| Analyse commits on demand              | [`manual-code-analysis.yml`](../examples/manual-code-analysis.yml)             | `workflow_dispatch`         |

The sections below explain the parts of these workflows you are most likely to change, and add two jobs that have no example file.

## Pull request review

A review job needs three things: the pull request number in the prompt, read access to the diff, and a way to post feedback.

```yaml
name: PR review

on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 1

      - uses: lw396/pi-agent-action@v1
        with:
          model: anthropic/<model-id>
          track_progress: true
          prompt: |
            REPO: ${{ github.repository }}
            PR NUMBER: ${{ github.event.pull_request.number }}

            Review this pull request. Focus on correctness, security and
            missing tests. Leave an inline comment for each specific issue,
            then summarise in the tracking comment.
          allowed_tools: "mcp__github_inline_comment__create_inline_comment,Bash(gh pr diff:*),Bash(gh pr view:*)"
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

- `track_progress: true` posts a tracking comment that the agent updates with its progress and summary. Without it, give the agent `Bash(gh pr comment:*)` and ask it to post a comment.
- Inline comments the agent does not mark as confirmed are held back and classified after the run, so test or probe comments are not posted. Set `classify_inline_comments: false` to post them as they are made.
- Put your team's checklist in the prompt, or in `AGENTS.md` so `@pi` mentions follow it too.

To review only changes to some paths, filter the event:

```yaml
on:
  pull_request:
    paths:
      - "src/auth/**"
      - "src/api/**"
```

To review only some authors, filter the job:

```yaml
jobs:
  review:
    if: contains(fromJSON('["new-teammate", "external-contributor"]'), github.event.pull_request.user.login)
```

Pull requests from forks do not get secrets on `pull_request`. Do not switch to `pull_request_target` to work around it before reading [Using this action with `pull_request_target`](./security.md#using-this-action-with-pull_request_target-or-workflow_run).

## Issue triage

The triage examples give the agent `gh` commands to read the issue and edit its labels, and nothing else:

```yaml
allowed_tools: "Bash(gh issue view:*),Bash(gh label list:*),Bash(gh issue edit:*)"
```

Anyone can open an issue, so the issue text is untrusted input. Keep the tools to what the job needs and the workflow's `permissions:` to `issues: write` and `contents: read`.

## Keeping docs in sync with code

When API code changes, have the agent update the docs on the same pull request:

```yaml
on:
  pull_request:
    paths:
      - "src/api/**"

jobs:
  docs:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.head_ref }}

      - uses: lw396/pi-agent-action@v1
        with:
          model: openai/<model-id>
          prompt: |
            REPO: ${{ github.repository }}
            PR NUMBER: ${{ github.event.pull_request.number }}

            Update docs/api.md to match the API changes in this pull request,
            then commit and push to the pull request's branch.
          allowed_tools: "Edit,Write,Bash(gh pr diff:*),Bash(git add:*),Bash(git commit:*),Bash(git push:*)"
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Pushes with the pi-agent-action app token start your CI again on the pull request; pushes with `GITHUB_TOKEN` do not.

## Scheduled maintenance

Run a recurring check and report the result in an issue:

```yaml
on:
  schedule:
    - cron: "0 3 * * 1" # Mondays 03:00 UTC
  workflow_dispatch:

jobs:
  maintenance:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
      issues: write
      id-token: write
    steps:
      - uses: actions/checkout@v6

      - uses: lw396/pi-agent-action@v1
        with:
          model: google/<model-id>
          prompt: |
            REPO: ${{ github.repository }}

            Look for TODO comments older than 90 days, deprecated API usage and
            dependencies with known problems. Open one issue titled
            "Weekly maintenance report" listing what you found, with file paths.
          allowed_tools: "Bash(git log:*),Bash(gh issue create:*)"
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

## Tips

- **Give context in the prompt.** Agent mode does not fetch the issue or pull request for the agent; include `github.repository` and the number, and allow the `gh` commands it needs to read them.
- **Allow commands one by one.** A command matched by a `Bash(...)` rule cannot be chained with `&&` or `|`. List each command the job needs.
- **Bound the run.** Set `timeout-minutes` on the job and choose a model priced for the job.
- **Check the cost.** The run summary in the Job Summary shows each run's tokens and estimated cost; `display_report: true` adds the turns.
