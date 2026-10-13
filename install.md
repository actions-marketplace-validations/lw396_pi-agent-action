# Install pi-agent-action

Instructions for a coding agent that a user asked to set up [pi-agent-action](https://github.com/lw396/pi-agent-action) in their repository. Work through the steps in order. Each ends on a condition that tells you it is done; reach it before you move on.

The user decides; you do the legwork. Ask one question at a time, offer a recommended answer first, and show every file before you write it.

Reference you will fetch along the way (raw files of `lw396/pi-agent-action` on `main`):

- `https://raw.githubusercontent.com/lw396/pi-agent-action/main/examples/pi.yml`: the workflow template
- `https://raw.githubusercontent.com/lw396/pi-agent-action/main/README.md`: the provider table, and the migration tables under "Migrating from claude-code-action"
- `https://raw.githubusercontent.com/lw396/pi-agent-action/main/docs/development/upstream-divergence.md`: every behaviour that differs from claude-code-action (in Chinese); entries marked 用户可见 = 是 are the ones a workflow can notice
- `https://raw.githubusercontent.com/lw396/pi-agent-action/main/docs/setup.md`: authentication options and the custom GitHub App guide

## 1. Check the environment

Run:

```bash
gh auth status
git rev-parse --show-toplevel
gh repo view --json nameWithOwner,defaultBranchRef,viewerPermission
```

Done when: `gh` is logged in, you are inside a git repository with a GitHub remote, and `viewerPermission` is `ADMIN`. Adding secrets and installing apps needs admin; if the user is not an admin, tell them who must run this instead and stop.

## 2. Find existing workflows

Search `.github/workflows/` for `uses: anthropics/claude-code-action` and `uses: lw396/pi-agent-action`.

- **Neither found**: a new install. Continue at step 3.
- **`anthropics/claude-code-action` found**: a migration. Do steps 3 to 5 as written, then in step 6 convert each of those workflows in place instead of adding `pi.yml`.
- **`lw396/pi-agent-action` found**: already installed. Show the user what the workflow sets (model, authentication, `allowed_tools`) and ask what to change; do only the steps that change touches.

Done when: you have told the user which branch applies and listed every workflow file it touches.

## 3. Choose how the action authenticates to GitHub

Offer these three, in this order:

1. **The pi-agent-action app** (recommended): comments and commits come from `pi-agent-action[bot]`, and its pushes start other workflows. The user installs it in the browser at https://github.com/apps/pi-agent-action/installations/new, choosing this repository. The workflow job needs `id-token: write` and leaves `github_token` unset.
2. **The workflow's `GITHUB_TOKEN`**: nothing to install. Comments come from `github-actions[bot]`, and pushes and pull requests the agent makes do not start other workflows. The workflow sets `github_token: ${{ secrets.GITHUB_TOKEN }}` and the job does not need `id-token: write`.
3. **Their own GitHub App**: follow "Using a Custom GitHub App" in `docs/setup.md`; the app's ID and private key become the `APP_ID` and `APP_PRIVATE_KEY` secrets in step 5.

Installing an app is a browser step only the user can take, and `gh` cannot see whether it happened. Ask the user to confirm; step 8 proves it, since a run without the app fails with an error asking to install it.

Done when: the user has picked an option and, for options 1 and 3, confirmed the app is installed on this repository.

## 4. Choose the model

Ask which provider and model to use. The provider table in the README gives the `model` prefix and the variable name pi reads the credentials from (for example `openai/<model-id>` and `OPENAI_API_KEY`). The user supplies the model ID; append `:<level>` only if they ask for a thinking level.

Done when: you have the exact `model` value and the name of every credential variable the provider needs.

## 5. Add the secrets

The secrets are each credential variable from step 4, plus `APP_ID` and `APP_PRIVATE_KEY` if the user chose their own GitHub App in step 3. Ask the user how they want to add them, offering these three in this order, and give them the commands or links with the repository (`nameWithOwner` from step 1) and the secret names filled in:

1. **Run the command in their own terminal** (recommended): a terminal outside this agent session, so the key never reaches the agent or its logs. One command per secret; `gh` prompts for the value without echoing it:

   ```bash
   gh secret set OPENAI_API_KEY --repo <owner>/<repo>
   ```

   For a key stored in a file, such as their own app's `.pem`, they redirect it instead: `gh secret set APP_PRIVATE_KEY --repo <owner>/<repo> < path/to/key.pem`. Point them away from `--body <key>`, which leaves the key in their shell history.

2. **Use the GitHub website**: open `https://github.com/<owner>/<repo>/settings/secrets/actions/new`, enter the secret name as you gave it, paste the value and click "Add secret".

3. **Paste the key into this conversation and let you add it**: the quickest, but the key then stays in the conversation history and goes to the agent's model provider. Say so when you offer this option. Pass the key on stdin, one secret per command:

   ```bash
   printf '%s' '<key>' | gh secret set OPENAI_API_KEY --repo <owner>/<repo>
   ```

   Keep the key out of everything else: your replies, files, commit messages and other commands.

For options 1 and 2, wait for the user to say they are done. A key the user pastes into the chat unasked is option 3: add it the same way.

Done when: `gh secret list` shows every secret the workflow will reference.

## 6. Write the workflow

**New install**: fetch `examples/pi.yml` and adapt it into `.github/workflows/pi.yml`:

- `model` and the `env:` credentials from steps 4 and 5
- authentication from step 3: keep `id-token: write` for option 1; for option 2 remove it and add `github_token`; for option 3 add the `actions/create-github-app-token` step from `docs/setup.md`
- `allowed_tools`: only the commands the agent needs to build and test this project, each as its own rule, for example `Bash(bun install),Bash(bun test:*)`. Read the project's `package.json`, `Makefile` or equivalent to find them, and propose the list to the user. A plain `Bash` or a `*` allows every command, so suggest one only if the user asks and point them to `docs/security.md` first.

**Migration**: rewrite each workflow from step 2 using the README tables "Removed inputs" and "Flags from `claude_args`": point `uses:` at `lw396/pi-agent-action@v1`, set `model`, the credentials and the authentication from step 3, move `claude_args` flags to their inputs, and carry the existing permission rules into `allowed_tools`. Ask whether to keep `@claude` as the trigger phrase (`trigger_phrase`, `label_trigger`, `branch_prefix`) or switch to the `@pi` defaults. List every user-visible entry of `upstream-divergence.md` that applies to these workflows, in the user's language, so the user sees what changes for them.

Done when: the user has approved the full content of every workflow file.

## 7. Open a pull request

Create a branch, commit the workflow files, push, and open a pull request against the default branch. If the push is refused for missing `workflow` scope, ask the user to run `gh auth refresh -s workflow`, then push again.

Tell the user that events like `issue_comment` run the workflow from the default branch, so `@pi` answers only after the pull request is merged.

Done when: the pull request is open and you have given the user its URL.

## 8. Try it

After the user merges the pull request, offer a test run. A comment is visible to everyone watching the repository, so ask before you post one. With approval, open an issue and comment `@pi say hello and list the top-level files`, then follow the run:

```bash
gh run list --workflow pi.yml --limit 1
gh run watch <run-id>
```

If the run fails, read the log with `gh run view <run-id> --log-failed`. The usual causes are a missing secret, a model ID the provider does not know, and, with option 1, the app not installed on the repository.

Done when: pi has replied on the issue, or the user has declined the test run.
