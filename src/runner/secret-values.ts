import { existsSync } from "node:fs";
import { delimiter, isAbsolute } from "node:path";
import { BASH_ENV_ALLOWLIST } from "./env-allowlist";

/**
 * Redaction by value (ADR-0002): keys of providers whose format is unknown
 * (OpenCode, for example) and secrets the workflow sets under its own names
 * cannot be matched by pattern, so every environment value outside the bash
 * env allowlist, of at least MIN_SECRET_LENGTH characters, is treated as a
 * secret and replaced wherever it turns up, raw, base64 or URL-encoded.
 *
 * Two kinds of value are left out, since replacing them would only garble
 * comments and summaries: the action's own non-secret settings
 * (ACTION_SETTINGS_ENV), and values that are existing absolute paths or
 * lists of them (RUNNER_TEMP, JAVA_HOME and the like). A secret is never a
 * path that exists; a credentials file's path is not the secret, its contents
 * are.
 */
const MIN_SECRET_LENGTH = 16;

export const REDACTED = "[REDACTED]";

/**
 * Variables the action's run step (action.yml) sets from its own inputs, for
 * settings that are not credentials. Redacting them by value only garbles
 * output: a value counts only when it turns up whole, so a prompt quoted in
 * full became [REDACTED], while a secret written into the prompt was never
 * caught this way unless it is in the environment under its own name too.
 *
 * Every variable the run step and the buffered inline comment post-step set
 * is in this list, in BASH_ENV_ALLOWLIST, or in ACTION_SECRET_ENV;
 * test/secret-values.test.ts checks that.
 */
export const ACTION_SETTINGS_ENV: readonly string[] = [
  "MODE",
  "PROMPT",
  "TRIGGER_PHRASE",
  "ASSIGNEE_TRIGGER",
  "LABEL_TRIGGER",
  "BASE_BRANCH",
  "BRANCH_PREFIX",
  "BRANCH_NAME_TEMPLATE",
  "ALLOWED_BOTS",
  "ALLOWED_NON_WRITE_USERS",
  "INCLUDE_COMMENTS_BY_ACTOR",
  "EXCLUDE_COMMENTS_BY_ACTOR",
  "USE_STICKY_COMMENT",
  "CLASSIFY_INLINE_COMMENTS",
  "USE_COMMIT_SIGNING",
  "BOT_ID",
  "BOT_NAME",
  "TRACK_PROGRESS",
  "ADDITIONAL_PERMISSIONS",
  "MODEL",
  "CLASSIFY_MODEL",
  "INPUT_SKILLS",
  "INPUT_PACKAGES",
  "INPUT_ALLOWED_TOOLS",
  "INPUT_DISALLOWED_TOOLS",
  "JSON_SCHEMA",
  "SUBPROCESS_ISOLATION",
  "ALLOWED_BASH_ENV",
  "INPUT_SHOW_FULL_OUTPUT",
  "DISPLAY_REPORT",
  // The buffered inline comment post-step
  "REPO_OWNER",
  "REPO_NAME",
  "PR_NUMBER",
];

/**
 * Variables those steps set that stay secrets: inputs that carry
 * credentials, free-form pass-through arguments (PI_ARGS) and ALL_INPUTS
 * (every input, api_key included). Nothing reads this list but the test that
 * keeps those steps' variables classified; anything they copy from the
 * workflow env is a secret too.
 */
export const ACTION_SECRET_ENV: readonly string[] = [
  "OVERRIDE_GITHUB_TOKEN",
  "DEFAULT_WORKFLOW_TOKEN",
  "GITHUB_TOKEN",
  "SSH_SIGNING_KEY",
  "API_KEY",
  "PI_ARGS",
  "ALL_INPUTS",
];

const NOT_SECRET_NAMES = new Set([
  ...BASH_ENV_ALLOWLIST,
  ...ACTION_SETTINGS_ENV,
]);

/** Whether the value is an existing absolute path, or a list of them. */
function isExistingPathList(value: string): boolean {
  return value
    .split(delimiter)
    .every((part) => isAbsolute(part) && existsSync(part));
}

/** The forms to replace, longest first so no form is left half-replaced. */
let secretForms: string[] = [];

/**
 * A value's base64 forms: on its own, then inside a larger blob at each of
 * the 3 offsets from a 3-byte group boundary. Inside a blob only the
 * characters made purely of the value's bits are fixed, so the characters
 * that mix in neighbouring bytes are left out.
 */
function base64Forms(value: string): string[] {
  const bytes = Buffer.from(value);
  const forms = [bytes.toString("base64")];
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString(
      "base64",
    );
    // The first character holding none of the offset bytes' bits, and the
    // end of the last character holding only the value's bits.
    const start = Math.ceil((offset * 8) / 6);
    const end = Math.floor(((offset + bytes.length) * 8) / 6);
    forms.push(encoded.slice(start, end));
  }
  return forms;
}

/**
 * Collect the secret values from the environment, replacing any collected
 * before. Called once at startup, before the action changes its environment.
 *
 * Until it is called, redactSecrets() matches known formats only. Every
 * process that publishes text and has secrets in its environment must call
 * it first: run.ts and the buffered inline comment post-step do. The MCP
 * servers do not need to, since their env holds no provider keys and the
 * Runner redacts MCP tool arguments by value before a call reaches them
 * (src/runner/comment-redaction.ts).
 * A value that an allowlisted variable also holds (PWD and GITHUB_WORKSPACE,
 * for example) is not a secret.
 */
export function collectSecretValues(env: NodeJS.ProcessEnv): void {
  const allowlisted = new Set(
    BASH_ENV_ALLOWLIST.map((name) => env[name]).filter(Boolean),
  );
  const values = Object.entries(env)
    .filter(([name]) => !NOT_SECRET_NAMES.has(name))
    .map(([, value]) => value)
    .filter(
      (value): value is string =>
        value !== undefined &&
        value.length >= MIN_SECRET_LENGTH &&
        !allowlisted.has(value) &&
        !isExistingPathList(value),
    );
  const forms = new Set(
    values.flatMap((value) => [
      value,
      encodeURIComponent(value),
      ...base64Forms(value),
    ]),
  );
  secretForms = [...forms].sort((a, b) => b.length - a.length);
}

/** Replace every form of the collected secret values with [REDACTED]. */
export function redactSecretValues(content: string): string {
  for (const form of secretForms) {
    content = content.replaceAll(form, REDACTED);
  }
  return content;
}
