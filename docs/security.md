# Security

pi-agent-action keeps claude-code-action's access checks, token handling and prompt sanitization. The agent underneath is different, and some protections upstream gets from its agent have no equivalent in pi. [What is weaker than in claude-code-action](#what-is-weaker-than-in-claude-code-action) lists them; read it before you migrate a workflow that processes untrusted input.

## Access Control

- **Repository Access**: The action can only be triggered by users with write access to the repository. This is checked for issue, pull request, comment, and review events, and for `workflow_run` events, where both the workflow actor and the actor that started the upstream run are checked. `workflow_dispatch`, `repository_dispatch`, and `schedule` events are not checked separately — GitHub itself requires write access to dispatch a workflow, and scheduled runs have no external actor.
- **Bot User Control**: By default, GitHub Apps and bots cannot trigger this action for security reasons. Use the `allowed_bots` parameter to enable specific bots or all bots
  - **⚠️ Allowed bots are not checked for repository permissions.** A bot that matches an entry does **not** need to be installed on your repository or have write access. On a **public repository**, external parties — including GitHub Apps created by anyone — may be able to trigger workflow events such as opening issues, commenting, or reviewing pull requests. If your workflow listens on those events and `allowed_bots` is set to `'*'`, any such App can invoke this action with a prompt it controls.
  - Prefer an explicit list over `'*'`
  - Only list App names you trust
  - If you need `'*'`, scope workflow `permissions:` to the minimum required
- **⚠️ Non-Write User Access (RISKY)**: The `allowed_non_write_users` parameter allows bypassing the write permission requirement. **This is a significant security risk and should only be used for workflows with extremely limited permissions** (e.g., issue labeling workflows that only have `issues: write` permission). This feature:
  - Only works when `github_token` is provided as input (not with GitHub App authentication)
  - Accepts either a comma-separated list of specific usernames or `*` to allow all users
  - **Should be used with extreme caution** as it bypasses the primary security mechanism of this action
  - Is designed for automation workflows where user permissions are already restricted by the workflow's permission scope
  - Isolates bash commands, as described in [Bash isolation](#bash-isolation-allowed_non_write_users). The isolation reduces but does not eliminate prompt injection risk, and on runners without bubblewrap it can be bypassed. Keep workflow permissions minimal and validate all outputs.
  - When using `allowed_non_write_users`, always pass `github_token: ${{ secrets.GITHUB_TOKEN }}`. The auto-generated workflow token is scoped to the job's declared permissions and expires when the job completes. **Do not use a personal access token** — a static token does not rotate between runs and could be partially or fully recovered over time via prompt injection. Restrict `allowed_tools` to the minimum the job needs (e.g. `allowed_tools: "Bash(gh issue view:*)"`).
- **Token Permissions**: The GitHub app receives only a short-lived token scoped specifically to the repository it's operating in
- **No Cross-Repository Access**: Each action invocation is limited to the repository where it was triggered
- **Limited Scope**: The token cannot access other repositories or perform actions beyond the configured permissions

## What is weaker than in claude-code-action

- **No safety review of tool calls.** claude-code-action can run with `--permission-mode auto`, in which a model reviews every tool call no rule covers and blocks risky ones. pi has no permission modes and no such review. A call runs if `allowed_tools` permits it and is refused otherwise; nothing judges what a permitted call does. A rule like `Bash` lets a prompt injection run any command, and `Edit` / `Write` let it change any file the runner user can write. See [Tool permissions](#tool-permissions).
- **Bash isolation can be bypassed without bubblewrap.** With `allowed_non_write_users`, claude-code-action's sandbox comes with the agent. Here, bash commands run in a bubblewrap sandbox only on Linux runners where bubblewrap can create one. Elsewhere — macOS and Windows runners, self-hosted runners without bubblewrap or without user namespaces, `container:` jobs — a command can read the agent's full environment, provider keys and `GH_TOKEN` included, through `/proc`. The run logs a warning (`bash runs without a sandbox: ...`) when this happens. See [Bash isolation](#bash-isolation-allowed_non_write_users).
- **The bash environment is an allowlist, not a blocklist.** This is stricter than upstream, but it means the commands your job runs lose variables they may need, until you list them in `allowed_bash_env`. Listing a secret there hands it to the agent.
- **No script call caps.** `CLAUDE_CODE_SCRIPT_CAPS`, which limits how many times a script may be called per run, is not supported and is ignored. `allowed_tools` can only decide whether a script may run at all.
- **Read tools are not limited to the working directory.** The read tools (Read, Grep, Glob, LS) always run, on any path except `/proc` when bash is isolated. Any secret an earlier step writes to disk, such as a cloud credentials file, is readable by the agent.
- **Redaction works on values the action knows about.** See [Output redaction](#output-redaction).

## Tool permissions

`allowed_tools` and `disallowed_tools` take rules in claude-code-action's syntax: a tool name (`Bash`, `Edit`, `Write`, `mcp__server__tool`, `mcp__server__*`) or `Bash(prefix:*)` for bash commands starting with that prefix.

- The read tools (Read, Grep, Glob, LS) always run. So does `codemode`, pi's script tool, once `pi_args: --tools +codemode` turns it on: each tool a script calls is checked like a direct call, but the classifier and image models a script can run, with the provider keys in `env:`, are not covered by any rule. Any other call that matches no `allowed_tools` rule is refused, and the reason is returned to the model. With no rules, the agent can neither run bash nor change files.
- `disallowed_tools` is checked first: a matching call is refused even if `allowed_tools` permits it.
- When a `Bash(...)` rule decides a call, the command must be one simple command. `&&`, `;`, `|`, `&`, newlines, `$()`, backticks, `${...}`, subshells and redirections are refused, because a prefix such as `Bash(git add:*)` would otherwise let `git add . && curl ...` through. A plain `Bash` rule allows every command.
- Only Bash rules take a pattern. A pattern on any other tool (`Edit(docs/**)`) fails the run rather than being ignored.
- Tag mode adds the rules it needs: the tracking comment tool, `git add`, `git commit`, `git rm` and the push wrapper (or the file operation tools with `use_commit_signing`), and `git status`, `diff`, `log` and `show` without options that write files or run programs. It allows file edits inside the working directory except `.git/`, whose hooks would run on the next commit. An explicit `Edit` or `Write` rule allows edits on any path.
- Use `*` in a tool name only for MCP tools (`mcp__github_ci__*`). A `*` anywhere else can name bash, edit and write at once.

Allow only the tools the job needs, keep workflow `permissions:` minimal, and where you can, run the job on a runner that filters outbound network traffic.

## Package trust

The `packages` input opts into third-party code with the action's operating-system permissions. pi extensions run in-process with access to the provider keys, GitHub token, files and network. Dependency installation may execute lifecycle scripts with the job's environment.

`allowed_tools` and `disallowed_tools` govern calls through pi's tool runtime, including package tools. They do **not** sandbox extension factories, event handlers, direct filesystem/network access or child processes an extension starts. Bash isolation applies only to the action's bash tool, not arbitrary extension code.

Review packages and their dependencies before enabling them. Pin npm versions and Git commit hashes, and set sources only in trusted workflow configuration: never interpolate issue/PR text or model output into `packages`. Installation outside the checkout prevents accidental commits, not code execution. Retain minimal job permissions, narrow tool rules and the egress firewall. Source URLs must not contain credentials; configure npm/Git authentication separately in trusted steps.

See [Pi packages](./configuration.md#pi-packages) for supported sources and failure behavior.

## Bash isolation (`allowed_non_write_users`)

When `allowed_non_write_users` is set, bash commands are isolated. Without it, bash commands see the agent's whole environment, including the provider key and `GH_TOKEN`, as in claude-code-action.

**Environment allowlist.** Bash commands keep only the variables in `BASH_ENV_ALLOWLIST` (`src/runner/env-allowlist.ts`):

- `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TMPDIR`, `CI`, `RUNNER_OS`, `RUNNER_ARCH`, `PWD`, `OLDPWD`
- the `GITHUB_*` variables that hold no secret and change nothing: repository, ref, SHA, run, job, workflow, actor, server and API URLs, `GITHUB_EVENT_PATH`, `GITHUB_WORKSPACE`, `GITHUB_ACTION_PATH`
- pi's session variables (`PI_SESSION_ID`, `PI_MODEL`, ...)

Everything else is removed: provider keys, `GH_TOKEN`, and any secret your workflow sets under its own name. `GITHUB_ENV`, `GITHUB_OUTPUT`, `GITHUB_PATH`, `GITHUB_STATE` and `GITHUB_STEP_SUMMARY` are removed too, because writing to them changes later steps.

To give commands more variables, list them in `allowed_bash_env`, separated by commas, spaces or newlines:

```yaml
- uses: lw396/pi-agent-action@v1
  with:
    allowed_non_write_users: "*"
    github_token: ${{ secrets.GITHUB_TOKEN }}
    allowed_tools: "Bash(gh issue edit:*)"
    allowed_bash_env: GH_TOKEN
```

`git push` and `gh` in bash need `GH_TOKEN`, and listing it gives the agent the token. Prefer `use_commit_signing`, whose commits and pushes go through the action's own tools and need no token in bash.

**Sandbox.** On Linux runners where bubblewrap can create a sandbox (the action installs it on GitHub-hosted Ubuntu runners), each command also runs with:

- a new PID namespace and `/proc`, so it cannot read the agent's environment or memory
- `no_new_privs`, so `sudo` cannot run as root
- a read-only file system apart from the working directory and an empty `/tmp`, so writes to caches under `HOME` fail; point caches into the workspace (`npm_config_cache: ${{ github.workspace }}/.npm` in `env:`, plus `allowed_bash_env: npm_config_cache`)
- no network isolation: a command can still reach any host the runner can

The file tools run inside the agent's process, outside the sandbox, so they refuse paths under `/proc` while bash is isolated. A command that swaps a symbolic link between the check and the read can defeat that check; the sandbox does not stop it.

**Without bubblewrap the isolation can be bypassed.** Only the environment allowlist applies, and a command can read the agent's environment, with every secret the allowlist removed, from `/proc/<pid>/environ`. This is the case on macOS and Windows runners, self-hosted runners without bubblewrap or without unprivileged user namespaces, and `container:` jobs. The run logs a warning. Do not combine `allowed_non_write_users` with any secret you cannot afford to lose on such a runner.

Set `subprocess_isolation: false` to turn off both the allowlist and the sandbox.

## Output redaction

Comments, the step summary, error messages and the full output log are redacted before they are published:

- Known token formats are matched by pattern: GitHub, Anthropic, OpenAI, OpenRouter, Google, AWS, Slack and JWTs.
- Every environment value of 16 characters or more is treated as a secret and replaced with `[REDACTED]`, raw, base64-encoded or URL-encoded, unless it is the value of a variable on the bash allowlist, one of the action's own settings that are not credentials (such as `prompt` and `model`; `pi_args` is still treated as a secret), or an existing file system path. This covers keys of providers with no known format.
- Arguments to the action's MCP tools, the comment tools included, are redacted before they reach the server.

Redaction is a last line of defense, and it has limits:

- Output the model has deliberately obfuscated — split, reversed, encoded some other way — gets through.
- A secret is only recognized if it is in the environment under its own name or matches a known format. A secret written into `prompt`, or a short one, is not. Pass secrets through `env:` rather than interpolating them into the prompt.
- Long non-secret values in the environment, such as URLs and paths that do not exist, are redacted too. To keep one visible in the output, write it into `prompt` instead of `env:`.

## Using this action with `pull_request_target` or `workflow_run`

For `workflow_run` events, the action checks the repository access of the actor that started the upstream run (for example, the author of the fork pull request that triggered your CI workflow) in addition to the workflow actor. If that actor does not have write access, the action stops before running the agent. To run on `workflow_run` events downstream of pull requests from contributors without write access, add those users to `allowed_non_write_users` and pass `github_token: ${{ secrets.GITHUB_TOKEN }}` — see the notes on that input above and keep the workflow's permissions minimal.

`pull_request_target` and `workflow_run` execute with the **base repository's secrets**. If your workflow checks out the PR head (`ref: ${{ github.event.pull_request.head.sha }}` for `pull_request_target`, `ref: ${{ github.event.workflow_run.head_sha }}` for `workflow_run`) into `$GITHUB_WORKSPACE` before this action, the action and the agent run with that checkout as the working directory.

**Do not check out an untrusted ref into the workspace root before this action.** Use one of these patterns instead:

```yaml
# Preferred — check out the base ref (default).
- uses: actions/checkout@v6 # no `ref:` → base branch
- uses: lw396/pi-agent-action@v1
```

```yaml
# If you need the PR's files locally — check out the base ref at the workspace
# root (this action expects a git repo there), then check out the head ref into
# a subdirectory. The agent's read tools can read it there.
- uses: actions/checkout@v6 # no `ref:` → base branch at workspace root
- uses: actions/checkout@v6
  with:
    # For workflow_run use: ${{ github.event.workflow_run.head_sha }}
    ref: ${{ github.event.pull_request.head.sha }}
    path: pr-head
- uses: lw396/pi-agent-action@v1
```

This is general guidance for these event types — see [GitHub's documentation](https://securitylab.github.com/research/github-actions-preventing-pwn-requests/).

### Which files come from the base branch on pull requests

When the action runs against a pull request, it restores a fixed list of agent configuration paths from the PR base branch before starting the agent: `.pi/`, `.agents/`, `AGENTS.md`, `AGENTS.MD`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.MD`, `CLAUDE.local.md`, `.claude/`, `.mcp.json`, `.claude.json`, `.gitmodules`, `.ripgreprc`, and `.husky/`. pi reads its context files, system prompt files, skills and extensions from these paths, and runs the extensions as code inside the action, with access to the provider key and the GitHub token. Restoring them from the base branch means a pull request cannot add or change instructions or code that the agent loads. Paths in that list that do not exist on the base branch are removed, and the PR-authored versions are kept under `.pi-pr/` for reference only.

Everything else in the working tree — including `package.json`, lockfiles, `Makefile`, `node_modules/`, and formatter/linter config files — stays at the PR head. If an extension or skill on the base branch runs a package-manager script (`bun run …`, `npm run …`, `yarn …`, `pnpm run …`), a `make` target, a repo-relative script, or a tool that loads executable project config, that command resolves through files the pull request supplies. Keep such commands self-contained: invoke the tool directly with a pinned version and pass its configuration on the command line (for example `bunx prettier@3.5.3 --no-config --write .` rather than `bun run format`).

Note that the runtime executing the tool also reads project config. `bunx <tool>` runs the tool's script under `node` when `node` is on `PATH` (as it is on GitHub-hosted runners); when only Bun is available, Bun executes the script itself and reads `bunfig.toml` from the checkout — including `preload` entries — which comes from the PR head. On such runners, make sure `node` is on `PATH`, and treat `bunfig.toml` and `.npmrc` in the checkout as PR-controlled runtime config.

## Pull Request Creation

In its default configuration, **the agent does not create pull requests automatically** when responding to `@pi` mentions. Instead:

- The agent commits code changes to a new branch
- The agent provides a **link to the GitHub PR creation page** in its response
- **The user must click the link and create the PR themselves**, ensuring human oversight before any code is proposed for merging

This design ensures that users retain full control over what pull requests are created and can review the changes before initiating the PR workflow.

## Prompt Injection Risks

**Beware of potential hidden markdown when tagging the agent on untrusted content.** External contributors may include hidden instructions through HTML comments, invisible characters, hidden attributes, or other techniques. The action sanitizes content by stripping HTML comments, invisible characters, markdown image alt text, hidden HTML attributes, and HTML entities, but new bypass techniques may emerge. We recommend reviewing the raw content of all input coming from external contributors before allowing the agent to process it.

On public repos, you can also use `include_comments_by_actor` to allowlist which users' comments are passed to the agent, reducing exposure to untrusted input. Use `exclude_comments_by_actor` to filter out noisy bot comments (e.g., `dependabot[bot]`, `renovate[bot]`). If an actor matches both lists, exclusion takes priority. See [Usage](./usage.md) for details.

## GitHub App Permissions

Without a `github_token` input, the action exchanges the workflow's GitHub OIDC token (the job needs `id-token: write`) at this project's token exchange service for a token of the [pi-agent-action app](https://github.com/apps/pi-agent-action). The service issues a token only for the repository the workflow runs in, and only when the workflow file matches the version on the default branch; see [ADR-0003](./development/adr/0003-own-github-app-token-exchange.md). The app has these permissions:

- **Contents** (Read & Write): For reading repository files and creating branches
- **Pull Requests** (Read & Write): For reading PR data and creating/updating pull requests
- **Issues** (Read & Write): For reading issue data and updating issue comments
- **Actions** (Read): For workflow runs and job logs (the CI tools); requested with `additional_permissions: actions: read`
- **Checks** (Read): For check run results; requested with `additional_permissions: checks: read`
- **Metadata** (Read): Required by GitHub

Tokens get Contents, Pull Requests and Issues by default. The service refuses a request for more than the app has. The app has no Workflows permission, so the agent cannot change files under `.github/workflows/`.

## Commit Signing

By default, commits made by the agent are unsigned. You can enable commit signing using one of two methods:

### Option 1: GitHub API Commit Signing (use_commit_signing)

This uses GitHub's API to create commits, which automatically signs them as verified from the GitHub App:

```yaml
- uses: lw396/pi-agent-action@v1
  with:
    use_commit_signing: true
```

This is the simplest option and requires no additional setup. However, because it uses the GitHub API instead of git CLI, it cannot perform complex git operations like rebasing, cherry-picking, or interactive history manipulation.

### Option 2: SSH Signing Key (ssh_signing_key)

This uses an SSH key to sign commits via git CLI. Use this option when you need both signed commits AND standard git operations (rebasing, cherry-picking, etc.):

```yaml
- uses: lw396/pi-agent-action@v1
  with:
    ssh_signing_key: ${{ secrets.SSH_SIGNING_KEY }}
    bot_id: "YOUR_GITHUB_USER_ID"
    bot_name: "YOUR_GITHUB_USERNAME"
```

Commits will show as verified and attributed to the GitHub account that owns the signing key.

**Setup steps:**

1. Generate an SSH key pair for signing:

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/signing_key -N "" -C "commit signing key"
   ```

2. Add the **public key** to your GitHub account:

   - Go to GitHub → Settings → SSH and GPG keys
   - Click "New SSH key"
   - Select **Key type: Signing Key** (important)
   - Paste the contents of `~/.ssh/signing_key.pub`

3. Add the **private key** to your repository secrets:

   - Go to your repo → Settings → Secrets and variables → Actions
   - Create a new secret named `SSH_SIGNING_KEY`
   - Paste the contents of `~/.ssh/signing_key`

4. Get your GitHub user ID:

   ```bash
   gh api users/YOUR_USERNAME --jq '.id'
   ```

5. Update your workflow with `bot_id` and `bot_name` matching the account where you added the signing key.

**Note:** If both `ssh_signing_key` and `use_commit_signing` are provided, `ssh_signing_key` takes precedence.

## Authentication Protection

**CRITICAL: Never hardcode your provider API key in workflow files!**

Store it in GitHub secrets and pass it through `env:` or `api_key`:

```yaml
# CORRECT ✅
env:
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
# OR
with:
  api_key: ${{ secrets.OPENAI_API_KEY }}

# NEVER DO THIS ❌
env:
  OPENAI_API_KEY: "sk-..." # Exposed and vulnerable!
```

### Custom OpenAI endpoints

`OPENAI_BASE_URL` sends the OpenAI provider's requests, prompts, tool definitions and API key to the configured endpoint. Set it only in trusted workflow configuration; never derive it from an issue, pull request or model output. Use HTTPS for remote endpoints, keep the endpoint's API key in GitHub Secrets, and restrict any management interface separately. Embedded URL credentials, query strings and fragments are rejected; pass credentials through `OPENAI_API_KEY` or `api_key` instead.

If a gateway uses OAuth for upstream access, keep its access and refresh tokens on the gateway host with persistent storage. Give the action only the gateway's API key. Keep the exact endpoint host on the egress allowlist and retain tool permissions and subprocess isolation; the endpoint override does not provide any additional sandboxing.

## Full Output Security Warning

The `show_full_output` option is **disabled by default** for security reasons. When enabled, it logs every pi event — model responses, tool calls and tool results — including:

- Full outputs from tool executions (e.g., `ps`, `env`, file reads)
- File contents that may include secrets
- Command outputs that may expose sensitive system information

The events are redacted as described in [Output redaction](#output-redaction), but redaction does not catch every secret. **These logs are publicly visible in GitHub Actions for public repositories!**

### Automatic Enabling in Debug Mode

Full output is **automatically enabled** when the job runs with debug logging (re-run with "Enable debug logging", or the `ACTIONS_STEP_DEBUG` secret or variable set to `true`). This helps with debugging but carries the same security risks.

### When to Enable Full Output

Only enable `show_full_output: true` or debug logging when:

- Working in a private repository with controlled access
- Debugging issues in a non-production environment
- You have verified no secrets will be exposed in the output
- You understand the security implications

### Recommended Practice

For debugging, prefer `show_full_output: false` (the default), which logs only the run's token and cost totals. The step summary (`display_report: true`) shows tool calls and their results too, so it carries the same risks.
