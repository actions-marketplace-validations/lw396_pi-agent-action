# Setup Guide

## Agent-assisted Setup

A coding agent can do the steps below for you: paste this into it from your repository.

```text
Read https://raw.githubusercontent.com/lw396/pi-agent-action/main/install.md and follow it to set up pi-agent-action in this repository.
```

It follows [install.md](../install.md): it asks you to install the app, lets you add the secret yourself or paste the key for it to add, writes the workflow and opens a pull request.

## Manual Setup

**Requirements**: You must be a repository admin to complete these steps.

1. Install the pi-agent-action GitHub app to your repository: https://github.com/apps/pi-agent-action
2. Pick a model and add its provider's credentials to your repository secrets ([Learn how to use secrets in GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)); see [Model Providers](#model-providers) below
3. Add a workflow file to your repository's `.github/workflows/`, starting from the [Quickstart](../README.md#quickstart). To authenticate as the app, grant the job `id-token: write` and leave `github_token` unset: the action exchanges the workflow's GitHub OIDC token for a token of the app

> Not installing the app? Set `github_token` instead: either `${{ secrets.GITHUB_TOKEN }}` (no app needed, but pushes and pull requests made with it do not start other workflows) or a token of [your own app](#using-a-custom-github-app). The job then does not need `id-token: write`.

## Model Providers

The action runs any model pi supports, so you are not tied to one API. Set the `model` input to `<provider>/<model-id>` and pass the provider's credentials in the workflow `env:`, under the variable name pi reads for that provider. For providers that use a single API key, the `api_key` input works too.

| Provider           | `model`                     | Credentials in `env:`                                                                                                  |
| ------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Anthropic (Claude) | `anthropic/<model-id>`      | `ANTHROPIC_API_KEY`                                                                                                    |
| OpenAI             | `openai/<model-id>`         | `OPENAI_API_KEY`                                                                                                       |
| Google Gemini      | `google/<model-id>`         | `GEMINI_API_KEY`                                                                                                       |
| OpenRouter         | `openrouter/<model-id>`     | `OPENROUTER_API_KEY`                                                                                                   |
| OpenCode           | `opencode/<model-id>`       | `OPENCODE_API_KEY`                                                                                                     |
| Amazon Bedrock     | `amazon-bedrock/<model-id>` | AWS credentials (`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, or `AWS_PROFILE`) and `AWS_REGION`                   |
| Google Vertex AI   | `google-vertex/<model-id>`  | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` and Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`) |

Other providers (DeepSeek, Mistral, xAI, Groq, Azure OpenAI, ...) follow the same pattern; see the [pi documentation](https://github.com/earendil-works/pi) for the full list and their variable names.

For example, with Claude:

```yaml
- uses: lw396/pi-agent-action@v1
  with:
    model: anthropic/<model-id>
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Switching providers only changes `model` and the variable in `env:`; the rest of the workflow stays the same.

## Using a Custom GitHub App

If you prefer not to install the [pi-agent-action app](https://github.com/apps/pi-agent-action), you can create your own GitHub App and pass its token to the action. This gives you complete control over permissions and access.

**When you may want to use a custom GitHub App:**

- You need more restrictive permissions than the pi-agent-action app
- Organization policies prevent installing third-party apps

### Setup

1. **Create a new GitHub App:**

   - Go to https://github.com/settings/apps/new (for a personal account) or your organization's Settings → Developer settings → GitHub Apps → New GitHub App
   - **GitHub App name:** any name; it becomes the app's bot name (`<name>[bot]`) on comments and commits
   - **Homepage URL:** any URL, e.g. your repository
   - **Webhook:** uncheck "Active". The action does not receive events; your workflow triggers it
   - **Callback URL** and **Request user authorization (OAuth) during installation:** leave empty and unchecked
   - **Repository permissions:**
     - Contents: Read and write
     - Issues: Read and write
     - Pull requests: Read and write
     - Actions: Read-only (only needed for the CI tools, `additional_permissions: actions: read`)
     - Metadata: Read-only (selected automatically)
   - Leave every other permission at "No access", including Workflows: the agent cannot change files under `.github/workflows/`
   - **Organization and account permissions:** none
   - **Subscribe to events:** none
   - **Where can this GitHub App be installed?** "Only on this account" is enough for your own repositories
   - Click "Create GitHub App"

   The same settings as a [GitHub App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), for tools that register apps from one:

   ```json
   {
     "name": "pi-agent-action custom app",
     "description": "Custom GitHub App for pi-agent-action",
     "url": "https://github.com/lw396/pi-agent-action",
     "hook_attributes": {
       "url": "https://example.com/github/webhook",
       "active": false
     },
     "redirect_url": "https://github.com/settings/apps/new",
     "callback_urls": [],
     "setup_url": "https://github.com/lw396/pi-agent-action/blob/main/docs/setup.md",
     "public": false,
     "default_permissions": {
       "contents": "write",
       "issues": "write",
       "pull_requests": "write",
       "actions": "read",
       "metadata": "read"
     },
     "default_events": []
   }
   ```

2. **Generate and download a private key:**

   - After creating the app, scroll down to "Private keys"
   - Click "Generate a private key"
   - Download the `.pem` file (keep this secure!)

3. **Install the app on your repository:**

   - Go to the app's settings page
   - Click "Install App"
   - Select the repositories where you want to use the action

4. **Add the app credentials to your repository secrets:**

   - Go to your repository's Settings → Secrets and variables → Actions
   - Add these secrets:
     - `APP_ID`: Your GitHub App's ID (found in the app settings)
     - `APP_PRIVATE_KEY`: The contents of the downloaded `.pem` file

5. **Update your workflow to use the custom app:**

   ```yaml
   name: pi with Custom App
   on:
     issue_comment:
       types: [created]
     # ... other triggers

   jobs:
     pi:
       runs-on: ubuntu-latest
       steps:
         # Generate a token from your custom app
         - name: Generate GitHub App token
           id: app-token
           uses: actions/create-github-app-token@v2
           with:
             app-id: ${{ secrets.APP_ID }}
             private-key: ${{ secrets.APP_PRIVATE_KEY }}

         - uses: actions/checkout@v6

         # Use the action with your custom app's token
         - uses: lw396/pi-agent-action@v1
           with:
             model: openai/<model-id>
             github_token: ${{ steps.app-token.outputs.token }}
             # ... other configuration
           env:
             OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
   ```

**Important notes:**

- The custom app must have read/write permissions for Issues, Pull Requests, and Contents
- Your app's token will have the exact permissions you configured, nothing more

For more information on creating GitHub Apps, see the [GitHub documentation](https://docs.github.com/en/apps/creating-github-apps).

## Security Best Practices

**⚠️ IMPORTANT: Never commit API keys directly to your repository! Always use GitHub Actions secrets.**

To securely use your provider's API key (Anthropic in this example):

1. Add your API key as a repository secret:

   - Go to your repository's Settings
   - Navigate to "Secrets and variables" → "Actions"
   - Click "New repository secret"
   - Name it after the variable pi reads for your provider, e.g. `ANTHROPIC_API_KEY`
   - Paste your API key as the value

2. Reference the secret in your workflow:
   ```yaml
   env:
     ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
   ```

**Never do this:**

```yaml
# ❌ WRONG - Exposes your API key
env:
  ANTHROPIC_API_KEY: "sk-ant-..."
```

**Always do this:**

```yaml
# ✅ CORRECT - Uses GitHub secrets
env:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

This applies to all sensitive values including API keys, access tokens, and credentials.
We also recommend that you always use short-lived tokens when possible

## Setting Up GitHub Secrets

1. Go to your repository's Settings
2. Click on "Secrets and variables" → "Actions"
3. Click "New repository secret"
4. Name: the variable pi reads for your provider (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, ...; see [Model Providers](#model-providers)); Value: your API key
5. Click "Add secret"

### Best Practices for Authentication

1. ✅ Always pass keys as `${{ secrets.<NAME> }}` in workflows, through `env:` or the `api_key` input. GitHub masks a secret's value in the job log; a key written into the workflow as a literal is not masked, and the runner echoes the step's inputs and environment there. See [Output redaction](./security.md#output-redaction) for what the action does with values on its way out.
2. ✅ Never commit API keys or tokens to version control
3. ✅ Regularly rotate your API keys and tokens
4. ✅ Use environment secrets for organization-wide access
5. ❌ Never share API keys or tokens in pull requests or issues
6. ❌ Avoid logging workflow variables that might contain keys
