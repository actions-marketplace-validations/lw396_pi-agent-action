/**
 * Upstream inputs that only made sense for Claude Code. action.yml still
 * declares them, because a composite action cannot see an undeclared input,
 * so that a workflow that sets one fails here instead of being ignored.
 */

export const MIGRATION_TABLE_URL =
  "https://github.com/lw396/pi-agent-action#migrating-from-claude-code-action";

/** Removed input name, and what to use instead. */
export const REMOVED_INPUTS: Record<string, string> = {
  anthropic_api_key:
    "set model to an anthropic/... model and pass the key as ANTHROPIC_API_KEY in the workflow env, or through api_key",
  claude_code_oauth_token:
    "use an API key for the model's provider, in the workflow env or through api_key",
  anthropic_federation_rule_id:
    "workload identity federation is not supported; use an API key for the model's provider",
  anthropic_organization_id:
    "workload identity federation is not supported; use an API key for the model's provider",
  anthropic_service_account_id:
    "workload identity federation is not supported; use an API key for the model's provider",
  anthropic_workspace_id:
    "workload identity federation is not supported; use an API key for the model's provider",
  anthropic_oidc_audience:
    "workload identity federation is not supported; use an API key for the model's provider",
  use_bedrock:
    "set model to an amazon-bedrock/... model and pass AWS credentials in the workflow env",
  use_vertex:
    "set model to a google-vertex/... model and pass GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION and credentials in the workflow env",
  use_foundry:
    "pi has no Microsoft Foundry provider; choose another provider in model",
  claude_args:
    "use model, pi_args, allowed_tools, disallowed_tools and json_schema",
  plugins: "pi has no Claude Code plugins; remove the input",
  plugin_marketplaces: "pi has no Claude Code plugins; remove the input",
  path_to_claude_code_executable:
    "pi runs inside the action's own process; remove the input",
  include_fix_links:
    "its 'Fix this' links opened Claude Code on the web, which pi has no equivalent of; remove the input",
};

/**
 * Throws when ALL_INPUTS (the toJson(inputs) of the run step) sets any
 * removed input. A missing or unparsable ALL_INPUTS is not an error.
 */
export function assertNoRemovedInputs(allInputsJson: string | undefined) {
  let allInputs: Record<string, unknown>;
  try {
    allInputs = JSON.parse(allInputsJson ?? "{}");
  } catch {
    return;
  }

  const used = Object.keys(REMOVED_INPUTS).filter(
    (name) => typeof allInputs[name] === "string" && allInputs[name] !== "",
  );
  if (used.length === 0) return;

  const lines = used.map((name) => `- ${name}: ${REMOVED_INPUTS[name]}`);
  throw new Error(
    `These inputs were removed in pi-agent-action:\n${lines.join("\n")}\n` +
      `See the migration table: ${MIGRATION_TABLE_URL}`,
  );
}
