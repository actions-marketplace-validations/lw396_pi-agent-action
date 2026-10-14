# pi-agent-action

[![CI](https://github.com/lw396/pi-agent-action/actions/workflows/ci-all.yml/badge.svg)](https://github.com/lw396/pi-agent-action/actions/workflows/ci-all.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A GitHub Action that runs the [pi coding agent](https://github.com/earendil-works/pi) on your issues and pull requests, with the model of your choice. Mention `@pi` in a comment to have it answer a question, review a change or implement a fix, or give it a `prompt` to run an automation. Claude, GPT, Gemini, models on Amazon Bedrock or Google Vertex AI, OpenRouter and any other provider pi supports all work the same way: you pick the model, the workflow stays the same.

> [!NOTE]
> This project is based on [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action) (MIT) and offers a migration path for its workflows. It is not an official product of Anthropic or of the pi project.

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

For an Anthropic gateway, set `ANTHROPIC_BASE_URL` (without `/v1`), as with Claude Code. See [Custom Anthropic endpoints](./docs/configuration.md#custom-anthropic-endpoints).

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

Everything else that behaves differently from claude-code-action, and why, is recorded in [docs/development/upstream-divergence.md](./docs/development/upstream-divergence.md) (in Chinese).

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
