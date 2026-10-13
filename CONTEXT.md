# pi-agent-action

A GitHub Action that runs the pi coding agent in response to GitHub events, with a migration path from claude-code-action.

## Language

**Upstream**:
The anthropics/claude-code-action repository that this project is ported from. Its behaviour is the starting point for this project, not a constraint; workflows written for it keep a migration path. The code is maintained independently of it.
_Avoid_: Original, Claude version

**Divergence**:
A behaviour that differs from Upstream, recorded with its reason category in `docs/development/upstream-divergence.md`.
_Avoid_: Difference, change, deviation

**Runner**:
The component that runs a pi session on a prepared prompt and produces the execution file.
_Avoid_: Executor, base-action

**Execution file**:
The record of one Runner session (turns, tool calls, usage), exposed as an action output.
_Avoid_: Transcript, log

**Token exchange service**:
The service this project runs (`services/token-exchange/`, on Cloudflare Workers) that trades a workflow's GitHub OIDC token for an installation token of the project's GitHub App, used when the `github_token` input is not set. See ADR-0003.
_Avoid_: Token server, OIDC proxy, exchange endpoint

**Tag mode**:
The mode in which the action is triggered by a trigger phrase, label, or assignee on an issue or PR.

**Agent mode**:
The mode in which the action runs the `prompt` input directly, without a trigger.

**Trigger phrase**:
The mention text (default `@pi`) that activates tag mode in a comment or issue body.
_Avoid_: Mention, tag
