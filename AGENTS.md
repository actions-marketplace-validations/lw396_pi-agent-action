# AGENTS.md

Guidance for coding agents (and humans) working on this repository. pi reads this file.

## Commands

```bash
bun test                # Run tests
bun run typecheck       # TypeScript type checking
bun run format          # Format with prettier
bun run format:check    # Check formatting
```

## What This Is

A GitHub Action that runs the [pi coding agent](https://github.com/earendil-works/pi) on GitHub issues and pull requests: it answers `@pi` mentions on issues/PRs (tag mode) or runs a task given in the `prompt` input (agent mode). Mode is auto-detected: if `prompt` is provided, it's agent mode; if triggered by a comment/issue event with the trigger phrase, it's tag mode. See `src/modes/detector.ts`.

## Relationship to Upstream

This project is ported from [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action) ("Upstream") and is a drop-in replacement for its users. It is maintained independently: fixes are not cherry-picked from Upstream, so refactor any code here, `src/github/*` and `src/mcp/*` included, without keeping it structurally close to Upstream. Compatibility is about behaviour workflows see, not code shape.

- The pi executor (the Runner) lives in `src/runner/`. Upstream's `base-action/` has been removed.
- Don't use "Claude" or Anthropic branding in new names, defaults, or user-facing text. References to Claude Code as Upstream's agent (migration notes, `CLAUDE.md` and `.claude/` paths that pi also reads) are fine.
- Match Upstream behaviour unless one of four reasons applies: `pi-capability`, `multi-provider`, `branding`, or `scope`. Any behaviour that differs from Upstream must add or update an entry in `docs/development/upstream-divergence.md` in the same change, with its reason category.
- Domain terms are defined in `CONTEXT.md`; architectural decisions are in `docs/development/adr/`.

## How It Runs

Single entrypoint: `src/entrypoints/run.ts` orchestrates everything — prepare (removed-input check, auth, permissions, trigger check, branch/comment creation), run pi in-process through the Runner (`src/runner/run-pi.ts`), then cleanup (update tracking comment, write step summary). SSH signing cleanup, inline comment classification and token revocation are separate `always()` steps in `action.yml`.

The Runner's config comes from env vars that `action.yml` sets from the inputs (`MODEL`, `PI_ARGS`, `INPUT_ALLOWED_TOOLS`, ...), not from action inputs directly. `readRunnerInputs()` in `src/runner/run-plan.ts` is the only place that reads them, and `runnerOptions()` merges them with what the mode adds; add a new Runner input there, not as another `process.env` read. Upstream-only inputs that were removed stay declared in `action.yml` as deprecated stubs so `src/entrypoints/removed-inputs.ts` can fail the run when a workflow still sets one; keep that list and the stubs in sync.

## Key Concepts

**Auth priority**: `github_token` input (user-provided) > the pi-agent-action GitHub App token, which `src/github/token.ts` gets by exchanging the workflow's OIDC token at the Token exchange service (`services/token-exchange/`, ADR-0003). Model provider keys are unrelated to GitHub auth: they come from the workflow `env:` or the `api_key` input.

**Mode lifecycle**: `detectMode()` in `src/modes/detector.ts` picks the mode name ("tag" or "agent"). Trigger checking and prepare dispatch are inlined in `run.ts`: tag mode calls `prepareTagMode()` from `src/modes/tag/`, agent mode calls `prepareAgentMode()` from `src/modes/agent/`.

**Prompt construction**: Tag mode's `prepareTagMode()` builds the prompt by fetching GitHub data (`src/github/data/fetcher.ts`), formatting it as markdown (`src/github/data/formatter.ts`), and writing it to a temp file via `createPrompt()`. Agent mode writes the user's prompt directly. The prompt includes issue/PR body, comments, diff, and CI status. This is the most important part of the action — it's what the model sees.

**Tool permissions**: pi has no permission modes. `src/runner/tool-permissions.ts` blocks every tool call that `allowed_tools` does not permit (read-only tools always run); `src/runner/tool-rules.ts` parses the Claude Code–style rule syntax users migrate with.

## Things That Will Bite You

- **Strict TypeScript**: `noUnusedLocals` and `noUnusedParameters` are enabled. Typecheck will fail on unused variables.
- **Discriminated unions for GitHub context**: `GitHubContext` is a union type — call `isEntityContext(context)` before accessing entity-specific fields like `context.issue` or `context.pullRequest`.
- **Token lifecycle matters**: The GitHub App token is obtained early and revoked in a separate `always()` step in `action.yml`. If you move token revocation into `run.ts`, it won't run if the process crashes. Same for SSH signing cleanup.
- **Error phase attribution**: The catch block in `run.ts` uses `prepareCompleted` to distinguish prepare failures from execution failures. The tracking comment shows different messages for each.
- **`action.yml` outputs reference step IDs**: Outputs like `execution_file`, `branch_name`, `github_token` reference `steps.run.outputs.*`. If you rename the step ID, update the outputs section too.
- **Integration testing**: the tests in this repo are unit tests (plus `test/pi-sdk/`, which pins pi SDK behaviour the Runner relies on). The `test-*.yml` workflows run the action against a real model and are manual dispatch only for now.

## Code Conventions

- Runtime is Bun, not Node. Use `bun test`, not `jest`.
- `moduleResolution: "bundler"` — imports don't need `.js` extensions.
- GitHub API calls should use retry logic (`src/utils/retry.ts`).
- The action's MCP servers (`src/mcp/`) run from the action directory with Bun; `src/runner/mcp-servers.ts` registers them with pi.
- Pi packages are pinned to exact versions in `package.json` and upgraded together (see `.github/dependabot.yml`).

## Security hardening for GitHub Actions

Workflow jobs in this repository that run the agent (this action, published or as a local action with a `pi_args` input, or anything that mentions `@earendil-works/pi-coding-agent`) run with three protections. Keep them when you add or edit a workflow.

1. **Egress-firewall runner.** The job has `runs-on: ubuntu-24.04-firewall`, a GitHub-hosted runner that filters the job's outbound network traffic. Do not move a job that runs the agent to another runner.
2. **Network allow list.** `.github/egress-firewall.yaml` lists the hosts those jobs may reach, besides any that GitHub's firewall allows by default. Keep `mode: enforce`, which is what makes the firewall block the rest. Follow that file's header when you add a host.
3. **Tool allowlist.** pi has no permission mode and no safety review: a tool call runs only if `allowed_tools` permits it (read-only tools always run). Allow only the tools the job needs, keep any `disallowed_tools` list a step has, and use `*` in a tool name only for MCP tools (`mcp__server__*`). A `*` anywhere else can name bash, edit and write at once.

`.github/workflows/workflow-hardening.yml` fails when a job that runs the agent breaks protection 1 or 3, or when the allow list is missing, empty, not `mode: enforce`, or names a host with `*`. It cannot see a job that runs the agent another way, so check new workflows by hand too. If a job cannot meet protection 1 or 3, add it with the reason to the matching exemption table (`EXEMPT_FROM_FIREWALL_RUNNER`, `EXEMPT_FROM_TOOL_ALLOWLIST`) in `.github/scripts/check_workflow_hardening.py`. Do not skip or weaken the check. Its tests are in `.github/scripts/test_check_workflow_hardening.py`: `python3 -m unittest discover -s .github/scripts -p 'test_*.py'`.

Keep each workflow's `permissions:` block minimal, and never print tokens or environment variables in workflow logs.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `lw396/pi-agent-action`, managed with the `gh` CLI. See `docs/development/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/development/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root and ADRs in `docs/development/adr/`, created lazily. See `docs/development/agents/domain.md`.
