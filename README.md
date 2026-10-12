# pi-agent-action

[![CI](https://github.com/lw396/pi-agent-action/actions/workflows/ci-all.yml/badge.svg)](https://github.com/lw396/pi-agent-action/actions/workflows/ci-all.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A GitHub Action that runs the [pi coding agent](https://github.com/earendil-works/pi) on your issues and pull requests, with the model of your choice. Mention `@pi` in a comment to have it answer a question, review a change or implement a fix, or give it a `prompt` to run an automation. Claude, GPT, Gemini, models on Amazon Bedrock or Google Vertex AI, OpenRouter and any other provider pi supports all work the same way: you pick the model, the workflow stays the same.

> [!NOTE]
> This project is based on [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action) (MIT) and is meant as a drop-in replacement for it. It is not an official product of Anthropic or of the pi project.

## Features

- **Any model**: set `model` to `<provider>/<model-id>`; switching providers changes one input and one secret
- **Two modes, picked automatically**: tag mode answers `@pi` mentions, assignments and labels on issues and pull requests; agent mode runs the `prompt` you give it, on any event
- **Code review and implementation**: reads the issue or pull request, the diff and CI status, then answers, leaves inline review comments or pushes a branch with the fix
- **Progress tracking**: a comment that updates as the agent works, with a link to the job run
- **Structured output**: `json_schema` turns the agent's answer into validated JSON action outputs
- **Explicit permissions**: the agent can always read files; every other tool call needs an `allowed_tools` rule
- **Runs on your runner**: the agent runs inside the action on your GitHub runner, and model requests go straight to your provider

## Quickstart

To have a coding agent (pi, Claude Code, Codex, ...) set it up for you, paste this into it from your repository:

```text
Read https://raw.githubusercontent.com/lw396/pi-agent-action/main/install.md and follow it to set up pi-agent-action in this repository.
```

It walks you through authentication, the model and its secret, writes the workflow (or migrates an existing claude-code-action one) and opens a pull request. To set it up by hand:

1. Add your provider's API key as a repository secret, e.g. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` ([Model providers](#model-providers)).
2. Add this workflow as `.github/workflows/pi.yml`:

```yaml
name: pi

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  pi:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: lw396/pi-agent-action@v1
        with:
          # Required: a pi model as provider/id
          model: anthropic/<model-id>
          github_token: ${{ secrets.GITHUB_TOKEN }}
          # Optional: commands the agent may run besides git add/commit/push
          allowed_tools: "Bash(npm test:*)"
        env:
          # The provider's key, under the variable name pi reads
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

3. Comment `@pi <request>` on an issue or pull request.

Only users with write access to the repository can trigger the action. See [GitHub authentication](#github-authentication) to have it act as its own bot instead of `github-actions[bot]`.

## Model providers

Set `model` to `<provider>/<model-id>` and pass the provider's credentials in `env:`, under the variable name pi reads for that provider. For providers that use a single API key, the `api_key` input works too.

| Provider           | `model`                     | Credentials in `env:`                                                               |
| ------------------ | --------------------------- | ----------------------------------------------------------------------------------- |
| Anthropic (Claude) | `anthropic/<model-id>`      | `ANTHROPIC_API_KEY`                                                                 |
| OpenAI             | `openai/<model-id>`         | `OPENAI_API_KEY`                                                                    |
| Google Gemini      | `google/<model-id>`         | `GEMINI_API_KEY`                                                                    |
| OpenRouter         | `openrouter/<model-id>`     | `OPENROUTER_API_KEY`                                                                |
| OpenCode           | `opencode/<model-id>`       | `OPENCODE_API_KEY`                                                                  |
| Amazon Bedrock     | `amazon-bedrock/<model-id>` | AWS credentials and `AWS_REGION`                                                    |
| Google Vertex AI   | `google-vertex/<model-id>`  | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` and Application Default Credentials |

Append `:<level>` to set a thinking level, e.g. `model: openai/<model-id>:high`. [docs/setup.md](./docs/setup.md#model-providers) has the details and the other providers.

For a trusted custom endpoint implementing the OpenAI Responses API, set `OPENAI_BASE_URL: https://your-api.example/v1` alongside its API key in `OPENAI_API_KEY` (or use `api_key`). This overrides only `openai`, including inline comment classification, and preserves pi's static model catalog. No service-specific integration is required. See [Custom OpenAI endpoints](./docs/configuration.md#custom-openai-endpoints) for requirements and limits.

## GitHub authentication

The action needs a GitHub token to read the issue or pull request, comment and push. There are three ways to give it one:

| Option                                                             | Workflow                                                              | Comments and commits from | Pushes start other workflows |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------- | ---------------------------- |
| The workflow's `GITHUB_TOKEN` (Quickstart)                         | `github_token: ${{ secrets.GITHUB_TOKEN }}`                           | `github-actions[bot]`     | No                           |
| The [pi-agent-action app](https://github.com/apps/pi-agent-action) | Install the app, grant the job `id-token: write`, omit `github_token` | `pi-agent-action[bot]`    | Yes                          |
| Your own GitHub App                                                | `github_token` from `actions/create-github-app-token`                 | Your app's bot            | Yes                          |

With the pi-agent-action app, the action exchanges the workflow's GitHub OIDC token for a short-lived token of the app at this project's token exchange service; the app's private key never leaves that service. A repository without the app installed gets an error asking you to install it or set `github_token`. [docs/setup.md](./docs/setup.md#using-a-custom-github-app) explains how to create your own app, and [docs/security.md](./docs/security.md#github-app-permissions) lists the app's permissions.

## Tools and security

The agent can always read files. Any other tool call (bash, file edits outside tag mode, MCP tools) runs only if `allowed_tools` permits it, and there is no safety review of the calls it permits. Read [docs/security.md](./docs/security.md) before you allow broad tools such as `Bash`.

## Migrating from claude-code-action

Most workflows need four changes:

1. Point `uses:` at `lw396/pi-agent-action`.
2. Set `model` and pass the provider's key.
3. Replace `claude_args` with the inputs listed under [Removed inputs](#removed-inputs).
4. List in `allowed_tools` the tools the job needs. Without a rule the agent cannot run bash or change files in agent mode.

```yaml
# Before
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    claude_args: |
      --model <model-id>
      --allowedTools "Bash(npm test:*),Edit,Write"

# After
- uses: lw396/pi-agent-action@v1
  with:
    model: anthropic/<model-id>
    allowed_tools: "Bash(npm test:*),Edit,Write"
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Removed inputs

A workflow that still sets one of these inputs fails, naming the input and what to use instead.

| Removed input                                                                                                                                    | YAML change                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic_api_key`                                                                                                                              | `model: anthropic/<id>`, and `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}` in `env:` (or `api_key: ${{ secrets.ANTHROPIC_API_KEY }}`)                     |
| `claude_code_oauth_token`                                                                                                                        | An API key for the model's provider, in `env:` under pi's variable name or in `api_key`                                                                           |
| `anthropic_federation_rule_id`, `anthropic_organization_id`, `anthropic_service_account_id`, `anthropic_workspace_id`, `anthropic_oidc_audience` | Not supported: remove them and use an API key for the model's provider                                                                                            |
| `use_bedrock`                                                                                                                                    | `model: amazon-bedrock/<id>`, and AWS credentials (`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, or `AWS_PROFILE`) and `AWS_REGION` in `env:`                  |
| `use_vertex`                                                                                                                                     | `model: google-vertex/<id>`, and `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` and Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`) in `env:` |
| `use_foundry`                                                                                                                                    | Not supported: pi has no Microsoft Foundry provider; choose another provider in `model`                                                                           |
| `claude_args`                                                                                                                                    | See the flag table below                                                                                                                                          |
| `settings`                                                                                                                                       | Not supported: remove it; move permission rules to `allowed_tools` / `disallowed_tools`                                                                           |
| `plugins`, `plugin_marketplaces`                                                                                                                 | Claude Code plugins are incompatible: remove them; use `skills` for generic skills or [`packages`](./docs/configuration.md#pi-packages) for native pi packages    |
| `include_fix_links`                                                                                                                              | Remove it: its "Fix this" links opened Claude Code on the web, which pi has no equivalent of                                                                      |
| `path_to_claude_code_executable`                                                                                                                 | Remove it: pi runs inside the action's own process, at the version the action pins                                                                                |

Flags from `claude_args`:

| `claude_args` flag                                 | YAML change                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `--model <id>`                                     | `model: <provider>/<id>`; append `:<level>` for a thinking level, e.g. `model: openai/<id>:high` |
| `--allowedTools "..."`                             | `allowed_tools: "..."`, same rule syntax                                                         |
| `--disallowedTools "..."`                          | `disallowed_tools: "..."`                                                                        |
| `--json-schema '...'`                              | `json_schema: '...'`; the schema's root must be `"type": "object"`                               |
| `--system-prompt "..."`                            | `pi_args: --system-prompt "..."` (`pi_args` takes pi's own flags only; see the `pi_args` input)  |
| `--append-system-prompt "..."`                     | `pi_args: --append-system-prompt "..."`                                                          |
| `--add-dir <dir>`                                  | Remove it: the read tools can read any path                                                      |
| `--max-turns`, `--permission-mode`, `--mcp-config` | Remove them: there is no equivalent, and `pi_args` fails on them                                 |

### Changed behaviour

Every row below changes something a workflow can observe.

| Area                                        | claude-code-action                                                                                      | pi-agent-action                                                                                                                                                                                                         | YAML change                                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Custom runtime                              | Custom agent executable via `path_to_claude_code_executable`                                            | pi runs in-process; `path_to_bun_executable` selects only Bun and rejects CR/LF before changing `PATH`                                                                                                                  | Remove agent executable overrides; optionally supply a single-line Bun path                                                                                                  |
| Model                                       | Default model, or `--model` in `claude_args`                                                            | No default: `model` is required                                                                                                                                                                                         | `model: <provider>/<id>`                                                                                                                                                     |
| OpenAI-compatible endpoints                 | No OpenAI provider                                                                                      | `OPENAI_BASE_URL` overrides only the `openai` provider for the Runner and inline comment classification; no official-endpoint fallback                                                                                  | Set `OPENAI_BASE_URL` and the proxy access key in `env:`; use a supported `openai/<id>`                                                                                      |
| GitHub App                                  | Without `github_token`, a token for the Claude app (`claude[bot]`) from Anthropic's exchange service    | Without `github_token`, a token for the pi-agent-action app (`pi-agent-action[bot]`) from this project's exchange service; `bot_id` / `bot_name` default to that bot                                                    | Install https://github.com/apps/pi-agent-action, or set `github_token`                                                                                                       |
| Trigger defaults                            | `@claude`, label `claude`, branch prefix `claude/`                                                      | `@pi`, `pi`, `pi/`                                                                                                                                                                                                      | To keep the old ones: `trigger_phrase: "@claude"`, `label_trigger: claude`, `branch_prefix: claude/`                                                                         |
| Tool permissions                            | Rules plus `--permission-mode auto`, which reviews calls no rule covers                                 | A call that no `allowed_tools` rule covers is refused; the read tools (Read, Grep, Glob, LS) always run; no safety review                                                                                               | `allowed_tools: "Bash(npm test:*),Edit,Write"`; plain `Bash` allows every command                                                                                            |
| Compound bash commands                      | `&&`, `;`, `\|` are split and each part matched                                                         | With a `Bash(...)` rule in play, `&&`, `;`, `\|`, `$()`, redirections and similar are refused; no built-in read-only commands (tag mode still allows `git status`, `diff`, `log`, `show`)                               | List every command the job runs: `allowed_tools: "Bash(npm ci:*),Bash(npm test:*),Bash(ls:*)"`                                                                               |
| Rule patterns for other tools               | `Read(src/**)`, `Edit(docs/**)`, `WebFetch(domain:...)`                                                 | Only Bash rules take a pattern; any other pattern fails the run. WebFetch and WebSearch rules are ignored with a warning                                                                                                | `allowed_tools: "Edit,Write"` instead of `Edit(docs/**)`; remove WebFetch and WebSearch rules                                                                                |
| Repository settings                         | `.claude/settings.json` in the repository is read                                                       | Neither `.claude/settings.json` nor `.pi/settings.json` is read                                                                                                                                                         | Move its `permissions.allow` / `deny` to `allowed_tools` / `disallowed_tools`                                                                                                |
| MCP servers                                 | Extra servers through `--mcp-config` or the repository's MCP config                                     | Only the action's own GitHub servers                                                                                                                                                                                    | No replacement yet: remove `--mcp-config`                                                                                                                                    |
| Slash commands in comments                  | `@claude /cmd` runs `.claude/commands/cmd.md`                                                           | `@pi /cmd` runs the prompt template `.pi/prompts/cmd.md`; `@pi /skill:name` runs a skill from `.pi/skills/` or `.agents/skills/`                                                                                        | Move `.claude/commands/*.md` to `.pi/prompts/`                                                                                                                               |
| Default tag-mode prompt                     | Fixed step-by-step workflow, analysis tags, and simple/complex change instructions                      | Concise request, environment, and completion contracts; implementation requires verification, and blocked items stay unchecked. Prompt guidance only; the simplified prompt and agent-mode custom prompts are unchanged | None                                                                                                                                                                         |
| Comment tool name                           | `mcp__github_comment__update_claude_comment`                                                            | `mcp__github_comment__update_comment`                                                                                                                                                                                   | Rename it in `prompt` and `allowed_tools`                                                                                                                                    |
| Agent env variables                         | `ANTHROPIC_*`, `CLAUDE_CODE_*`, `MCP_TIMEOUT`, `OTEL_*` in `env:` take effect                           | Not read                                                                                                                                                                                                                | Remove them; set the provider variables pi reads, e.g. `AWS_REGION`, `GOOGLE_CLOUD_PROJECT`                                                                                  |
| Script call caps                            | `CLAUDE_CODE_SCRIPT_CAPS: '{"script.sh":2}'` in `env:`                                                  | Not supported; ignored                                                                                                                                                                                                  | Remove it; limit which scripts run with `allowed_tools: "Bash(./script.sh:*)"`                                                                                               |
| Inline comment classification               | Claude Haiku, key from `anthropic_api_key`                                                              | Through pi with the `model` input; `classify_model` picks a classifier (e.g. `opencode/jev-1.13`) or another chat model. Every buffered comment is posted when classification fails                                     | Nothing; set `classify_model` to use another model, with its provider's key in `env:`                                                                                        |
| Bash env with `allowed_non_write_users`     | Built-in blocklist; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: 0` turns it off                                  | Allowlist; `GH_TOKEN` and provider keys are removed                                                                                                                                                                     | `allowed_bash_env: GH_TOKEN` for `git push` / `gh` in bash (or `use_commit_signing: true`); `subprocess_isolation: false` to turn it off                                     |
| Bash sandbox with `allowed_non_write_users` | Built-in sandbox                                                                                        | bubblewrap where it works: only the working directory and an empty `/tmp` are writable                                                                                                                                  | Point caches into the workspace, e.g. `npm_config_cache: ${{ github.workspace }}/.npm` in `env:` plus `allowed_bash_env: npm_config_cache`; or `subprocess_isolation: false` |
| Output redaction                            | Known token formats                                                                                     | Also every env value of 16 or more characters that is not on the allowlist, so long non-secret values show as `[REDACTED]` in comments and the step summary                                                             | To keep a long non-secret value visible, write it into `prompt` instead of `env:`                                                                                            |
| Structured output                           | `--json-schema` in `claude_args`                                                                        | `json_schema` input; same `structured_output` output                                                                                                                                                                    | `json_schema: '{"type":"object",...}'`                                                                                                                                       |
| Execution file                              | Agent SDK messages; cost in the final `result` message                                                  | pi events; totals in the final `session_stats` record                                                                                                                                                                   | None in YAML; a script that reads `execution_file` must read `session_stats` (`cost`, `durationMs`)                                                                          |
| Tracking comment                            | `Claude Code is working…`, then `**Claude finished @user's task**` or `**Claude encountered an error**` | `pi is working…`, then `**Pi finished @user's task**` or `**pi encountered an error**`                                                                                                                                  | Update scripts or filters that match the old text                                                                                                                            |
| "Create a PR" link                          | Title `... Changes from Claude`; body signed `Generated with [Claude Code](https://claude.ai/code)`     | Title `... Changes from pi`; no signature                                                                                                                                                                               | None                                                                                                                                                                         |
| Step summary                                | `Claude Code Report` from SDK messages                                                                  | `pi Agent Report` from pi events, with token and cost totals                                                                                                                                                            | None                                                                                                                                                                         |
| Full output                                 | `show_full_output`, or `ACTIONS_STEP_DEBUG: true` in `env:`, prints messages unredacted                 | `show_full_output`, or a run with debug logging enabled, prints pi events, redacted                                                                                                                                     | Replace `ACTIONS_STEP_DEBUG: true` in `env:` with `show_full_output: true`, or re-run the job with debug logging                                                             |
| `session_id` output                         | Can be resumed with `--resume`                                                                          | pi's session ID; the session cannot be resumed                                                                                                                                                                          | Remove later steps that resume the session; read the run from `execution_file`                                                                                               |
| Approval check                              | `anthropics/claude-code-action/agent-approval-check` sub-action                                         | Not included                                                                                                                                                                                                            | Keep `uses: anthropics/claude-code-action/agent-approval-check@main` (as upstream's example does); add the identity the action commits as to `agent_emails` / `agent_logins` |

## Documentation

- [Setup](./docs/setup.md): model providers, the GitHub App or your own, and handling secrets
- [Usage](./docs/usage.md): modes, events, every input and output, structured output
- [Configuration](./docs/configuration.md): tool permissions, instructions, CI access, MCP servers, branches
- [Solutions](./docs/solutions.md): ready-to-use workflows for reviews, triage, CI fixes and scheduled jobs
- [Security](./docs/security.md): access control, tool permissions, bash isolation, redaction, and what is weaker than in claude-code-action
- [FAQ](./docs/faq.md)

## Contributing

Bug reports, fixes and documentation improvements are welcome. See [CONTRIBUTING.md](./.github/CONTRIBUTING.md) for the development setup, and [SECURITY.md](./.github/SECURITY.md) to report a vulnerability.

## License

MIT, see [LICENSE](./LICENSE). Portions are copyright Anthropic, PBC, from [claude-code-action](https://github.com/anthropics/claude-code-action).
