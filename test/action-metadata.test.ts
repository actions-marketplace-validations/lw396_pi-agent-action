import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { REMOVED_INPUTS } from "../src/entrypoints/removed-inputs";
import { APP_BOT_ID, APP_BOT_LOGIN } from "../src/github/constants";
import { DEFAULT_MAX_RETRIES } from "../src/runner/run-plan";

const metadata = readFileSync(
  new URL("../action.yml", import.meta.url),
  "utf8",
);

function inputBlock(name: string): string | undefined {
  return metadata.match(new RegExp(`^  ${name}:\\n((?:    .*\\n)+)`, "m"))?.[1];
}

function inputDefault(name: string): string | undefined {
  return inputBlock(name)?.match(/^    default: "(.*)"$/m)?.[1];
}

// Names of the inputs declared in action.yml whose block matches pattern.
function inputsMatching(pattern: RegExp): string[] {
  const inputsSection = metadata.split(/^outputs:$/m)[0] ?? "";
  return [...inputsSection.matchAll(/^  (\w+):\n((?:    .*\n)+)/gm)]
    .filter(([, , block]) => pattern.test(block ?? ""))
    .map(([, name]) => name ?? "");
}

describe("action metadata", () => {
  test("defaults bot_id and bot_name to the pi-agent-action app's bot", () => {
    expect(inputDefault("bot_id")).toBe(String(APP_BOT_ID));
    expect(inputDefault("bot_name")).toBe(APP_BOT_LOGIN);
    expect(inputBlock("bot_id")).not.toMatch(/claude/i);
    expect(inputBlock("bot_name")).not.toMatch(/claude/i);
  });

  test("should expose the conclusion output from the run step", () => {
    expect(metadata).toMatch(
      /^  conclusion:\n    description: .+\n    value: \$\{\{ steps\.run\.outputs\.conclusion \}\}$/m,
    );
  });

  test("passes the model, api_key and pi_args inputs to the run step", () => {
    expect(metadata).toMatch(
      /^  model:\n    description: .+\n    required: true$/m,
    );
    expect(metadata).toMatch(
      /^  api_key:\n    description: .+\n    required: false$/m,
    );
    expect(inputDefault("pi_args")).toBe("");
    expect(metadata).toContain("        MODEL: ${{ inputs.model }}\n");
    expect(metadata).toContain("        API_KEY: ${{ inputs.api_key }}\n");
    expect(metadata).toContain("        PI_ARGS: ${{ inputs.pi_args }}\n");
  });

  test("passes the max_retries input to the run step, defaulting to 10", () => {
    expect(inputDefault("max_retries")).toBe(String(DEFAULT_MAX_RETRIES));
    expect(metadata).toContain(
      "        INPUT_MAX_RETRIES: ${{ inputs.max_retries }}\n",
    );
  });

  test("passes the allowed_tools and disallowed_tools inputs to the run step", () => {
    expect(inputDefault("allowed_tools")).toBe("");
    expect(inputDefault("disallowed_tools")).toBe("");
    expect(metadata).toContain(
      "        INPUT_ALLOWED_TOOLS: ${{ inputs.allowed_tools }}\n",
    );
    expect(metadata).toContain(
      "        INPUT_DISALLOWED_TOOLS: ${{ inputs.disallowed_tools }}\n",
    );
  });

  test("passes the subprocess isolation inputs to the run step", () => {
    expect(inputDefault("allowed_bash_env")).toBe("");
    expect(inputDefault("subprocess_isolation")).toBe("true");
    expect(metadata).toContain(
      "        SUBPROCESS_ISOLATION: ${{ inputs.subprocess_isolation }}\n",
    );
    expect(metadata).toContain(
      "        ALLOWED_BASH_ENV: ${{ inputs.allowed_bash_env }}\n",
    );
    expect(metadata).not.toContain("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB");
  });

  test("keeps the hardening steps for allowed_non_write_users", () => {
    expect(metadata).toContain(
      "apt-get install -y --no-install-recommends bubblewrap",
    );
    expect(metadata).toContain("name: Pin bun binary for post-steps");
    expect(metadata).toMatch(
      /name: Re-prepend system bin dirs to PATH\n      if: \$\{\{ always\(\) && inputs\.allowed_non_write_users != ''/,
    );
  });

  test("passes the show_full_output input to the run step", () => {
    expect(inputDefault("show_full_output")).toBe("false");
    expect(metadata).toContain(
      "        INPUT_SHOW_FULL_OUTPUT: ${{ inputs.show_full_output }}\n",
    );
  });

  test("passes export_session to the run step, off by default, with the files as outputs", () => {
    expect(inputDefault("export_session")).toBe("false");
    expect(metadata).toContain(
      "        INPUT_EXPORT_SESSION: ${{ inputs.export_session }}\n",
    );
    expect(metadata).toContain(
      "    value: ${{ steps.run.outputs.session_jsonl }}\n",
    );
    expect(metadata).toContain(
      "    value: ${{ steps.run.outputs.session_html }}\n",
    );
  });

  test("defaults the triggers and branch prefix to pi branding", () => {
    expect(inputDefault("trigger_phrase")).toBe("@pi");
    expect(inputDefault("label_trigger")).toBe("pi");
    expect(inputDefault("branch_prefix")).toBe("pi/");
  });

  test("declares each removed input only as a deprecated stub", () => {
    for (const name of Object.keys(REMOVED_INPUTS)) {
      const block = inputBlock(name);
      expect(block, name).toBeDefined();
      expect(block, name).toMatch(/^    deprecationMessage: .+$/m);
      expect(block, name).not.toMatch(/^    default:/m);
      expect(metadata, name).not.toContain(`inputs.${name} `);
    }
    expect(inputsMatching(/^    deprecationMessage:/m).sort()).toEqual(
      Object.keys(REMOVED_INPUTS).sort(),
    );
    // The removed-input check reads every input from ALL_INPUTS.
    expect(metadata).toContain("        ALL_INPUTS: ${{ toJson(inputs) }}\n");
  });

  test("passes no Claude Code configuration to the run step", () => {
    for (const name of [
      "CLAUDE_ARGS",
      "INPUT_SETTINGS",
      "INPUT_PLUGINS",
      "INPUT_PLUGIN_MARKETPLACES",
      "PATH_TO_CLAUDE_CODE_EXECUTABLE",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_BEDROCK_BASE_URL",
      "CLAUDE_CODE_ENABLE_TELEMETRY",
    ]) {
      expect(metadata).not.toContain(name);
    }
  });
});
