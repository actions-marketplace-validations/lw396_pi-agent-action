# Contributing

Thanks for helping improve pi-agent-action. Bug reports, fixes and documentation changes are all welcome. For a larger change, open an issue first so we can agree on the approach.

## Development setup

Requires [Bun](https://bun.sh/) (the version `action.yml` pins).

```bash
git clone https://github.com/lw396/pi-agent-action.git
cd pi-agent-action
bun install
bun run install-hooks   # optional: format, typecheck and test before each commit
```

| Command                | What it does                    |
| ---------------------- | ------------------------------- |
| `bun test`             | Run the unit tests              |
| `bun run typecheck`    | Type check with `tsc`           |
| `bun run format`       | Format with Prettier            |
| `bun run format:check` | Check formatting (CI runs this) |

## Project layout

| Path                       | Contents                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `action.yml`               | Inputs, outputs and the composite steps                                                     |
| `src/entrypoints/run.ts`   | Orchestrates a run: prepare, run pi, update the comment                                     |
| `src/modes/`               | Tag mode and agent mode                                                                     |
| `src/github/`              | GitHub context, data fetching, branches, comments, token handling                           |
| `src/create-prompt/`       | Builds the prompt the model sees                                                            |
| `src/runner/`              | Runs pi in process: tool permissions, bash isolation, structured output, the execution file |
| `src/mcp/`                 | The action's MCP servers (comments, inline comments, file operations, CI)                   |
| `services/token-exchange/` | The Cloudflare Worker that issues pi-agent-action app tokens                                |
| `examples/`                | Workflows users copy                                                                        |
| `docs/`                    | User documentation; `docs/development/` holds design notes and ADRs                         |

`AGENTS.md` describes the architecture and the things that tend to bite; read it before a structural change.

## Relationship to claude-code-action

This project is ported from [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action) and stays close to it, so fixes can be taken from there. Behaviour differs from it only for one of four reasons: pi works differently (`pi-capability`), multiple model providers (`multi-provider`), branding (`branding`), or a deliberate non-goal (`scope`). A change that makes behaviour differ must record the difference in [`docs/development/upstream-divergence.md`](../docs/development/upstream-divergence.md) and, if users see it, in the migration tables in the README.

## Pull requests

1. Branch from `main`.
2. Keep the change focused, and add or update tests for behaviour changes.
3. Run `bun test`, `bun run typecheck` and `bun run format:check`.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages (`feat:`, `fix:`, `docs:`, ...).
5. Update the docs in the same pull request when inputs, outputs or behaviour change.

Changes to `.github/workflows/` must keep the hardening that [`workflow-hardening.yml`](./workflows/workflow-hardening.yml) checks: jobs that run the agent use the egress-firewall runner, the network allow list and a narrow `allowed_tools`. `AGENTS.md` explains each.

## Trying a change end to end

Unit tests don't run the action against GitHub and a real model. To try your branch, point a workflow in a test repository at it:

```yaml
- uses: your-username/pi-agent-action@your-branch
  with:
    model: <provider>/<model-id>
```

and check the job log. The `test-*.yml` workflows in this repository do the same against a real model and can be started by hand from the Actions tab.

### Running workflows locally with act

[act](https://github.com/nektos/act) runs the workflows in Docker:

```bash
act pull_request -W .github/workflows/ci.yml          # unit tests, Prettier, typecheck
act pull_request -W .github/workflows/ci.yml -j test -v
```

The `test-*.yml` workflows run on `ubuntu-24.04-firewall`, which act doesn't know: map it with `-P ubuntu-24.04-firewall=catthehacker/ubuntu:act-latest` (the egress firewall is not applied locally) and pass the model key with `--secret OPENCODE_API_KEY="$OPENCODE_API_KEY"`.

## Releasing

Tag a commit on main with the version and push the tag:

```bash
git tag v1.2.0 && git push origin v1.2.0
```

`.github/workflows/release.yml` runs CI on it, creates the GitHub release with generated notes, and moves the major tag (`v1`) that workflows use to the same commit. A tag that is not on main fails the release.

## Reporting bugs and security issues

Open a [bug report](https://github.com/lw396/pi-agent-action/issues/new/choose) with your workflow file and the job log. Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md), not in a public issue.
