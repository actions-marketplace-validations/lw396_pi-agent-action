# Configuration

Recipes for the settings most workflows change. [Usage](./usage.md#inputs) lists every input.

## Choosing a model

Set `model` to `<provider>/<model-id>` and pass the provider's key in `env:` ([Model providers](./setup.md#model-providers)). Append `:<level>` for a thinking level:

```yaml
- uses: lw396/pi-agent-action@v1
  with:
    model: openai/<model-id>:high
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Inline review comments are classified by `model` too. To use a cheaper model or a dedicated classifier for that, set `classify_model` and add its provider's key to `env:`:

```yaml
with:
  model: anthropic/<model-id>
  classify_model: opencode/jev-1.13
env:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
```

## Custom OpenAI endpoints

Set `OPENAI_BASE_URL` in the action step's `env:` to route the `openai` provider through any trusted endpoint implementing the OpenAI Responses API. This can be a third-party model service, a self-hosted gateway or a local server; the action does not depend on a particular service or provider extension.

```yaml
with:
  model: openai/<model-id>:high
  # Optional: another chat model supported by the same endpoint
  classify_model: openai/<classification-model-id>
env:
  OPENAI_BASE_URL: https://api.example.com/v1
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

For a complete manually triggered, read-only workflow, see [Custom OpenAI endpoints](../examples/custom-openai-endpoints.yml).

Use an API key accepted by your endpoint. The `api_key` input can supply that key instead of `OPENAI_API_KEY`; it still applies only to the provider of `model`. The action does not perform interactive OAuth login or persist credentials for custom endpoints.

- Supply the full API base URL, including `/v1` when the service requires it. The action does not append `/v1`; the OpenAI Responses transport sends requests to `<base-url>/responses`. An endpoint that only implements Chat Completions (`/chat/completions`) is not supported by this override.
- URLs must be absolute HTTP(S), without embedded credentials, query strings or fragments. Surrounding whitespace and trailing slashes are removed. Use HTTPS for remote endpoints; HTTP is available for local testing.
- The override applies to every `openai` model operation, including compaction and the separate inline-comment classification step. Other providers, including `openai-codex` and Azure, are unchanged. Use `model: openai/<model-id>`, not `openai-codex/<model-id>`.
- Models and their capabilities still come from pi's pinned static catalog. The endpoint must support the selected model ID, streaming Responses API and tool calls; unknown model aliases are not discovered automatically. Dedicated classifier models require their own API support (for OpenAI, Decisions); use a chat model for classification when the endpoint only supports Responses.
- An unset or blank value preserves the official OpenAI endpoint. A failed custom-endpoint request does not fall back to the official API or another provider. Classification failures keep the existing behavior: every eligible buffered comment is posted.
- Keep the endpoint domain on your runner's network allowlist. For this repository's firewall runner, add its exact hostname to `.github/egress-firewall.yaml` with a usage comment; do not disable enforcement or use wildcard hosts.

`OPENAI_BASE_URL` is an action-supported environment override, not a new action input or pi CLI flag. The action continues to ignore `models.json`; no additional provider extension is required. Treat catalog cost figures as estimates, not the custom service's actual bill.

## Custom Anthropic endpoints

Set `ANTHROPIC_BASE_URL` in the action step's `env:` to route the `anthropic` provider through a trusted endpoint implementing the Anthropic Messages API, such as a company gateway, LiteLLM or another proxy. Claude Code reads the same variable, so a workflow migrated from claude-code-action keeps its gateway.

```yaml
with:
  model: anthropic/<model-id>
env:
  ANTHROPIC_BASE_URL: https://gateway.example.com
  # The gateway's key, sent as x-api-key...
  ANTHROPIC_API_KEY: ${{ secrets.GATEWAY_API_KEY }}
  # ...or a token sent as Authorization: Bearer
  # ANTHROPIC_AUTH_TOKEN: ${{ secrets.GATEWAY_TOKEN }}
```

- Supply the base URL **without** `/v1`: the Anthropic transport sends requests to `<base-url>/v1/messages`, so `https://gateway.example.com/v1` would call `/v1/v1/messages`. This is the opposite of `OPENAI_BASE_URL`.
- The `api_key` input can supply the key instead of `ANTHROPIC_API_KEY`. Use a key your gateway issues: do not send a Claude subscription OAuth token (`sk-ant-oat...`) to a third-party endpoint.
- The model ID must be in pi's pinned `anthropic` catalog, e.g. `claude-sonnet-4-5`, and the gateway must accept it. Services that offer an Anthropic-compatible API under their own model IDs cannot be selected this way. The gateway must support streaming, tool use and the `anthropic-beta` headers pi sends.
- The override applies to every `anthropic` model operation, including compaction and inline comment classification. Amazon Bedrock, Google Vertex and other providers are unchanged.
- URL validation, the absence of an official-endpoint fallback, and the network allowlist work as for [`OPENAI_BASE_URL`](#custom-openai-endpoints).

## Letting the agent run commands

The agent can always read files. Everything else needs a rule in `allowed_tools`. List each command the job runs by its prefix:

```yaml
with:
  allowed_tools: "Bash(npm ci),Bash(npm test:*),Bash(npm run lint:*)"
```

- `Bash(npm test:*)` allows `npm test` with any arguments; `Bash(npm ci)` allows exactly `npm ci`.
- A command matched by a `Bash(...)` rule must be a single command: `&&`, `;`, `|`, `$()` and redirections are refused, so the agent runs the commands one by one.
- `Edit` and `Write` let agent mode change files. Tag mode can already edit files in the working directory.
- `disallowed_tools` wins over `allowed_tools`, e.g. `allowed_tools: Bash` with `disallowed_tools: "Bash(git push:*)"`.

Plain `Bash` allows every command. Read [Tool permissions](./security.md#tool-permissions) before using it on a job that processes input from people outside your team.

Commands run with the job's environment, so set what they need in the step's `env:`:

```yaml
env:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  NODE_ENV: test
  DATABASE_URL: postgres://test:test@localhost:5432/test
```

### Scripts (codemode)

pi's `codemode` tool lets the model write a JavaScript script that calls other tools, in parallel if it likes, and passes back only what the script prints. It is off by default, as in pi. Turn it on with:

```yaml
with:
  pi_args: --tools +codemode
```

`codemode` itself needs no rule, but each tool a script calls is checked against `allowed_tools` like a direct call. Scripts can also run classifier and image models with the provider keys in `env:`; no rule covers those calls. See [Tool permissions](./security.md#tool-permissions).

## Instructions for the agent

pi reads these files from the checked-out repository, as it does locally, so project conventions you already keep there apply in the action too:

| Path                             | Effect                                                          |
| -------------------------------- | --------------------------------------------------------------- |
| `AGENTS.md` (or `CLAUDE.md`)     | Project instructions, added to the context                      |
| `.pi/APPEND_SYSTEM.md`           | Appended to pi's system prompt                                  |
| `.pi/SYSTEM.md`                  | Replaces pi's system prompt                                     |
| `.pi/skills/`, `.agents/skills/` | Skills the agent loads when a request matches their description |
| `.pi/prompts/`                   | Prompt templates you run from a comment with `@pi /<name>`      |
| `.pi/extensions/`                | pi extensions, **run as code inside the action**                |

Extensions run with the action's permissions: they can read the provider key and the GitHub token. Only commit extensions you would run in your CI.

The repository's `.pi/settings.json` and `.pi/mcp.json` are not read; see [MCP servers](#mcp-servers). On pull requests, all of these files come from the base branch, not from the pull request; see [Which files come from the base branch](./security.md#which-files-come-from-the-base-branch-on-pull-requests).

For instructions that only apply in CI, use `pi_args`:

```yaml
with:
  pi_args: |
    --append-system-prompt "Answer in the language of the issue. Keep comments under 200 words."
```

`--system-prompt` replaces pi's system prompt instead of appending to it. `--no-context-files` and `--no-skills` stop pi from reading the repository's files.

### Skills from other repositories

`skills` installs [agent skills](https://agentskills.io) from GitHub repositories with [`gh skill install`](https://cli.github.com/manual/gh_skill_install), one per line:

```yaml
with:
  skills: |
    github/awesome-copilot git-commit@v1.2.0
    monalisa/skills-repo skills/monalisa/code-review --pin 3f2a9c1
    my-org/agent-skills --all
```

- Each line is a repository in `OWNER/REPO` form, then a skill name or path (`@version` or `--pin` pins it to a tag or commit), or `--all` for every skill in the repository. `--allow-hidden-dirs` is also accepted.
- Without a version, gh installs the latest release, or the default branch when there is none.
- Skills are installed outside the checkout, so they are never committed with the agent's changes. They are loaded even with `--no-skills` in `pi_args`, which then only drops the repository's own skills.
- gh must be on the runner; GitHub-hosted runners have it. It uses the action's GitHub token, so a private skills repository needs a `github_token` that can read it.

A skill is instructions the agent follows and scripts it may run, written by someone else. Review it before you list it, and pin it so it cannot change under you. The scripts still need `allowed_tools` rules to run.

### Pi packages

Use `packages` for [native pi packages](https://pi.dev/docs/latest/packages) that bundle extensions, skills, prompt templates and themes. Keep `skills` for ordinary GitHub skill repositories; both inputs can be used together.

```yaml
with:
  packages: |
    # Examples; replace these with packages you have reviewed.
    npm:@example/pi-tools@1.2.3
    git:github.com/example/pi-review@v1.0.0
  allowed_tools: package_review
```

- Each non-empty, non-comment line is one source, not a `pi install` command. Supported sources are `npm:NAME[@VERSION]` (including scoped names, tags and simple ranges such as `^1.2.3`) and `git:HOST/OWNER/REPO[@REF]`, also with an explicit HTTP(S) URL after `git:`. Shorthand Git sources use HTTPS. Local paths, bare URLs, SSH sources, embedded credentials and install flags are not supported.
- Pin npm packages to exact versions and Git packages to full commit hashes for reproducible CI. Tags and branches can move. Without a version/ref, pi resolves the package's current default.
- The Runner installs packages and their dependencies through the action's pinned pi SDK before calling the model. npm sources need `npm`; Git sources need `git`, and Git packages with a `package.json` also need `npm`. Private sources use the runner's npm/Git authentication; `GH_TOKEN` alone is not automatically Git authentication. Configure credentials in trusted setup steps, not in a source URL.
- Installations live in a per-run directory under `RUNNER_TEMP` (or the system temp directory), outside the checkout. The action does not persist package declarations or read/write `~/.pi/agent/settings.json` or the repository's `.pi/settings.json`.
- All resources declared by the package manifest are loaded; otherwise pi uses its conventional resource directories. Explicit package skills and prompts survive `--no-skills` and `--no-prompt-templates` in `pi_args`, which only disable automatic discovery. Themes are resolved too, but this headless action has no interactive theme display.
- Installation or resource loading failures stop the run before calling the model. A package with no loadable pi resources fails too, including a missing package that pi would otherwise skip in offline mode. These are Runner startup failures, not `skills` prepare failures.
- Package tools still need `allowed_tools` rules; `disallowed_tools` takes precedence. Use the actual tool names the package registers, not the package name.

**Packages are trusted code, not sandboxed tools.** Extensions execute inside the action process, and dependency installation may run lifecycle scripts. They can access files, network and credentials directly, outside `allowed_tools` and bash isolation. Review packages and their dependencies, set sources only in trusted workflow configuration, and never derive them from issue/PR text or model output. Keep minimal workflow permissions and the runner's egress firewall; allow only the exact registry/Git hosts and package endpoints the job needs. See [Package trust](./security.md#package-trust).

## Reading CI results

With `actions: read`, the agent gets tools to read workflow runs and job logs on the pull request it works on (`mcp__github_ci__get_ci_status`, `mcp__github_ci__get_workflow_run_details`, `mcp__github_ci__download_job_log`), so `@pi why did CI fail?` works.

```yaml
permissions:
  contents: write
  pull-requests: write
  issues: write
  actions: read
  id-token: write

jobs:
  pi:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: lw396/pi-agent-action@v1
        with:
          model: anthropic/<model-id>
          additional_permissions: |
            actions: read
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

`additional_permissions` adds permissions to the pi-agent-action app token, one `name: level` per line (`actions: read`, `checks: read`, ...). With `github_token`, the token already has its own permissions: grant `actions: read` in the workflow's `permissions:` or in your app instead.

## MCP servers

The agent gets the action's own GitHub servers:

| Server                  | Tools                                                           | Available                                             |
| ----------------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| `github_comment`        | `update_comment`                                                | Tag mode, or agent mode when `allowed_tools` names it |
| `github_file_ops`       | `commit_files`, `delete_files`                                  | With `use_commit_signing`                             |
| `github_inline_comment` | `create_inline_comment`                                         | On pull requests, when `allowed_tools` names it       |
| `github_ci`             | `get_ci_status`, `get_workflow_run_details`, `download_job_log` | On pull requests, when the token has `actions: read`  |

Address them as `mcp__<server>__<tool>` in `allowed_tools`, e.g. `mcp__github_inline_comment__create_inline_comment` for a review job.

Adding your own MCP servers is not supported yet: the repository's `.mcp.json` is not read, and there is no `--mcp-config` equivalent.

## Branches and comments

```yaml
with:
  trigger_phrase: "@claude" # keep the phrase your team already uses
  label_trigger: ai-fix # label that starts the agent on an issue
  branch_prefix: bot/
  branch_name_template: "{{prefix}}{{entityNumber}}-{{description}}"
  use_sticky_comment: true # one comment per pull request
  exclude_comments_by_actor: "*[bot]" # leave bot comments out of the prompt
```

## Limiting time and cost

There is no turn limit. Bound a run with the job's `timeout-minutes`, keep `allowed_tools` narrow, and pick a cheaper model for routine jobs. The `execution_file` output and the step summary (`display_report: true`) show tokens and cost per run.

```yaml
jobs:
  pi:
    runs-on: ubuntu-latest
    timeout-minutes: 20
```

## Custom Bun

On Nix or in custom containers where the action cannot install Bun, point it at your own:

```yaml
with:
  path_to_bun_executable: /nix/store/.../bin/bun
```

Use the Bun version the action pins (see `action.yml`); others may not work. The executable path must be a single line: CR/LF characters are rejected before its directory is added to the job's `PATH`. Spaces in the path are supported.
