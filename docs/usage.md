# Usage

This page covers how the action decides what to do, how to talk to it, and every input and output. For setup, start with the [Quickstart](../README.md#quickstart).

## Modes

The action picks its mode from the workflow, so there is no `mode` input:

- **Tag mode** (no `prompt` input): the action runs when a comment, issue or review contains the trigger phrase (`@pi` by default), when an issue is assigned to `assignee_trigger`, or when an issue gets the `label_trigger` label. It posts a tracking comment, updates it as it works, and replies there.
- **Agent mode** (`prompt` is set): the action runs the prompt on any event, with no trigger check. It does not post a tracking comment unless you set `track_progress: true` on a supported `pull_request` or `issues` event.

| Event                                                                  | Tag mode | Agent mode |
| ---------------------------------------------------------------------- | -------- | ---------- |
| `issue_comment`, `pull_request_review_comment`                         | Yes      | Yes        |
| `issues` (`opened`, `edited`, `assigned`, `labeled`)                   | Yes      | Yes        |
| `pull_request_review`                                                  | Yes      | Yes        |
| `pull_request`, `pull_request_target`                                  | No       | Yes        |
| `workflow_dispatch`, `repository_dispatch`, `schedule`, `workflow_run` | No       | Yes        |

Only users with write access to the repository can trigger the action. See [Access control](./security.md#access-control) for bots and users without write access.

## Talking to the agent

Mention the trigger phrase anywhere in a comment, issue body or review. The agent reads the issue or pull request, its comments, the diff and CI status, then answers in the tracking comment.

```
@pi what does this function do, and how could it be simpler?
@pi add error handling to parseConfig
@pi review this PR, focusing on the database migrations
@pi here's a screenshot of the bug [image]. Can you fix it?
```

The trigger phrase must be a whole word: `@pi!` matches `@pi`, `@pi-bot` does not. Set `trigger_phrase` to use another phrase, e.g. `@claude` to keep the one your team is used to.

What the agent does with a request:

- **On an issue**, it creates a branch (`pi/issue-<number>-<timestamp>` by default), commits there, and links a prefilled "Create a PR" page in its comment. It does not open the pull request itself.
- **On an open pull request**, it pushes to the pull request's branch.
- **On a closed pull request**, it creates a new branch, as for an issue.
- **Reviews**: with `mcp__github_inline_comment__create_inline_comment` in `allowed_tools`, it can leave inline comments on the diff. It cannot submit, approve or merge a review.

### Slash commands

Start the request with a slash command to run instructions kept in the repository:

```
@pi /skill:review-pr focus on the auth changes
@pi /triage 42 needs-info
```

- `/skill:<name> [text]` loads the skill `<name>` from `.pi/skills/`, `.agents/skills/`, or the `skills`/`packages` inputs and adds your text after it.
- `/<name> [args]` runs a prompt template from `.pi/prompts/` or a `packages` input, with `$1`, `$@` and the like replaced by the arguments.

The command must come right after the trigger phrase. An unknown name is left as text for the agent to read. When the workflow sets `prompt` with `track_progress`, the action does not expand commands from comments or descriptions, so the workflow's `prompt` stays the task; put the command in `prompt` instead. Skills also load without a command when a request matches their description. On pull requests, these files come from the base branch.

Running commands other than `git add`, `commit` and `push` needs `allowed_tools`; see [Tool permissions](./security.md#tool-permissions).

## Inputs

### Model

| Input      | Description                                                                                                                                                                                                                                                        | Default |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `model`    | **Required.** The model, as `<provider>/<model-id>`, optionally with `:<thinking-level>` (e.g. `openai/<model-id>:high`). See [Model providers](./setup.md#model-providers)                                                                                        | -       |
| `api_key`  | API key for the `model` provider, used instead of the provider's environment variable                                                                                                                                                                              | -       |
| `skills`   | Agent skills to install with `gh skill install`, one per line: `OWNER/REPO <skill>[@version]`, or `OWNER/REPO --all`; `--pin` and `--allow-hidden-dirs` are also accepted. See [Skills from other repositories](./configuration.md#skills-from-other-repositories) | `""`    |
| `packages` | Trusted pi packages, one `npm:NAME[@VERSION]` or `git:HOST/OWNER/REPO[@REF]` per line. Installs outside the checkout; extensions run as code inside the action. See [Pi packages](./configuration.md#pi-packages)                                                  | `""`    |
| `pi_args`  | Extra pi flags. Supported: `--thinking`, `--system-prompt`, `--append-system-prompt`, `--tools`, `--exclude-tools`, `--no-tools`, `--no-builtin-tools`, `--no-skills`, `--no-prompt-templates`, `--no-context-files`. Any other flag fails the run                 | `""`    |

### Prompt and output

| Input                | Description                                                                                                                                                                                                                      | Default |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `prompt`             | Instructions for the agent. Setting it switches to agent mode                                                                                                                                                                    | `""`    |
| `track_progress`     | In agent mode, post and update a tracking comment as tag mode does. Only for `pull_request` (`opened`, `synchronize`, `ready_for_review`, `reopened`, `labeled`) and `issues` (`opened`, `edited`, `labeled`, `assigned`) events | `false` |
| `json_schema`        | A JSON Schema with `"type": "object"`. The agent submits its result through a tool whose arguments must match the schema; the result is the `structured_output` output. See [Structured output](#structured-output)              | `""`    |
| `use_sticky_comment` | On pull requests, reuse the action's previous comment instead of posting a new one                                                                                                                                               | `false` |
| `display_report`     | Write the pi Agent Report (the agent's turns, tokens and cost) to the step summary. The report contains model-written text; enable it only for trusted input                                                                     | `false` |
| `show_full_output`   | Log every pi event as JSON in the job log. Known secrets are redacted, but tool results can still contain sensitive data. For debugging only; a debug re-run does the same                                                       | `false` |

### Tools

| Input              | Description                                                                                                                                                                                    | Default |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `allowed_tools`    | Tool rules the agent may use: `Bash`, `Edit`, `Write`, `mcp__server__tool`, `mcp__server__*` or `Bash(<prefix>:*)`. Read-only tools always run; any other call that no rule permits is refused | `""`    |
| `disallowed_tools` | Rules the agent may not use, checked before `allowed_tools`                                                                                                                                    | `""`    |

See [Tool permissions](./security.md#tool-permissions) for the rule syntax and what tag mode allows on its own.

### Triggers and branches

| Input                  | Description                                                                                                                                                                              | Default                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `trigger_phrase`       | Phrase that triggers tag mode in comments, issue bodies and titles                                                                                                                       | `@pi`                                                     |
| `assignee_trigger`     | Username whose assignment to an issue triggers tag mode                                                                                                                                  | -                                                         |
| `label_trigger`        | Label that triggers tag mode when applied to an issue                                                                                                                                    | `pi`                                                      |
| `base_branch`          | Branch new branches start from                                                                                                                                                           | Repository default branch                                 |
| `branch_prefix`        | Prefix of branches the action creates                                                                                                                                                    | `pi/`                                                     |
| `branch_name_template` | Branch name template. Variables: `{{prefix}}`, `{{entityType}}`, `{{entityNumber}}`, `{{timestamp}}`, `{{sha}}`, `{{label}}`, `{{description}}` (first 5 words of the title, kebab-case) | `{{prefix}}{{entityType}}-{{entityNumber}}-{{timestamp}}` |

### Access and comments

| Input                       | Description                                                                                                                                                                          | Default |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `allowed_bots`              | Bot usernames that may trigger the action, comma-separated, or `*` for all. On public repositories `*` lets external apps run the agent with prompts they control                    | `""`    |
| `allowed_non_write_users`   | **Risky.** Users without write access who may trigger the action, or `*`. Only works with `github_token`. See [Bash isolation](./security.md#bash-isolation-allowed_non_write_users) | `""`    |
| `allowed_bash_env`          | Environment variables bash commands keep when `allowed_non_write_users` is set, besides the built-in allowlist. `git push` and `gh` in bash need `GH_TOKEN`                          | `""`    |
| `subprocess_isolation`      | `false` turns off the environment allowlist and the bubblewrap sandbox for bash when `allowed_non_write_users` is set                                                                | `true`  |
| `include_comments_by_actor` | Only include comments by these users in the prompt, comma-separated. `*[bot]` matches every bot                                                                                      | `""`    |
| `exclude_comments_by_actor` | Leave out comments by these users. Wins over `include_comments_by_actor`                                                                                                             | `""`    |
| `classify_inline_comments`  | Hold back inline review comments not marked `confirmed`, and post only those a model classifies as real review feedback, after the run. `false` posts every inline comment at once   | `true`  |
| `classify_model`            | Model that classifies held-back inline comments, as `<provider>/<model-id>`. Empty uses `model`. If classification fails, every held-back comment is posted                          | `""`    |

### GitHub authentication and commits

| Input                    | Description                                                                                                                                                        | Default                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `github_token`           | GitHub token to act with. Without it, the action uses the [pi-agent-action app](./setup.md) (the job needs `id-token: write`)                                      | -                      |
| `additional_permissions` | Extra permissions for the app token, one `name: level` per line, e.g. `actions: read` for the CI tools. A `github_token` keeps the permissions it was created with | `""`                   |
| `use_commit_signing`     | Commit through the GitHub API, so commits are signed and verified. The agent cannot rebase or run other git commands that rewrite history                          | `false`                |
| `ssh_signing_key`        | SSH key to sign commits with, keeping the full git CLI. Takes precedence over `use_commit_signing`. See [Commit signing](./security.md#commit-signing)             | `""`                   |
| `bot_id`                 | GitHub user ID for commit authorship                                                                                                                               | `339978130`            |
| `bot_name`               | GitHub username for commit authorship                                                                                                                              | `pi-agent-action[bot]` |
| `path_to_bun_executable` | Use this Bun instead of installing one, for Nix or custom containers                                                                                               | `""`                   |

Inputs that only made sense for Claude Code (`anthropic_api_key`, `claude_args`, `settings`, ...) are still declared so that a workflow setting them fails with a migration hint. See [Removed inputs](../README.md#removed-inputs).

## Outputs

| Output              | Description                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `conclusion`        | `success` or `failure`                                                                                                                          |
| `execution_file`    | Path to a JSON array with the session header and every pi event; the last record, `session_stats`, has the token usage, `cost` and `durationMs` |
| `branch_name`       | The branch the agent created, if any                                                                                                            |
| `structured_output` | The result as a JSON string, when `json_schema` is set                                                                                          |
| `session_id`        | pi's session ID                                                                                                                                 |
| `github_token`      | The GitHub token the action used                                                                                                                |

## Structured output

With `json_schema`, the agent ends the run by submitting a result that must match the schema. If it stops without submitting, it is reminded up to two times, then the run fails. Read the result with `fromJSON()`:

```yaml
- name: Detect flaky tests
  id: analyze
  uses: lw396/pi-agent-action@v1
  with:
    model: anthropic/<model-id>
    prompt: |
      Check the CI logs of run ${{ github.event.workflow_run.id }} and decide
      whether the failure is a flaky test.
    additional_permissions: |
      actions: read
    json_schema: |
      {
        "type": "object",
        "properties": {
          "is_flaky": { "type": "boolean" },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
          "summary": { "type": "string" }
        },
        "required": ["is_flaky", "confidence", "summary"]
      }
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

- name: Retry if flaky
  if: fromJSON(steps.analyze.outputs.structured_output).is_flaky
  run: gh run rerun ${{ github.event.workflow_run.id }} --failed
  env:
    GH_TOKEN: ${{ github.token }}
```

In a shell step, parse it with `jq`:

```yaml
- run: echo "$OUTPUT" | jq -r '.summary'
  env:
    OUTPUT: ${{ steps.analyze.outputs.structured_output }}
```

A composite action cannot declare outputs at run time, so every field is in the single `structured_output` string. [`examples/test-failure-analysis.yml`](../examples/test-failure-analysis.yml) is a complete workflow.

## Prompt templates

In agent mode the prompt is plain text, so use GitHub expressions to give the agent context:

```yaml
prompt: |
  REPO: ${{ github.repository }}
  PR NUMBER: ${{ github.event.pull_request.number }}

  Review this pull request for security issues: injection, authentication
  bypasses and exposed secrets. Rate each finding Critical, High, Medium or Low.
```

Useful values: `github.repository`, `github.event.pull_request.number`, `github.event.issue.number`, `github.event.pull_request.title`, `github.event.comment.body`, `github.actor`, `github.base_ref`, `github.head_ref`.

Do not put untrusted text, such as issue titles or comment bodies from people without write access, into the prompt of a job with broad tools. See [Prompt injection risks](./security.md#prompt-injection-risks).
