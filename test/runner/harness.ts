// Shared setup for Runner tests: runPi() driven end to end by pi's faux
// provider. No real model is called, and nothing outside the scratch
// directory is touched: RUNNER_TEMP and HOME point into it for the duration
// of each test.
import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseToolRules, type ToolRule } from "../../src/runner/tool-rules";

export type Scratch = {
  root: string;
  cwd: string;
};

export const OIDC_AND_INPUT_VARS = [
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ALL_INPUTS",
];
const ENV_KEYS = [
  "RUNNER_TEMP",
  "HOME",
  "FAUX_TEST_API_KEY",
  "PATH",
  ...OIDC_AND_INPUT_VARS,
];

/**
 * Give each test in the file a fresh scratch directory and environment.
 * Returns a getter, since the directory changes from test to test.
 */
export function useScratch(): () => Scratch {
  let scratch: Scratch;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), "run-pi-test-"));
    savedEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    process.env.RUNNER_TEMP = join(root, "runner-temp");
    process.env.HOME = join(root, "home");
    process.env.FAUX_TEST_API_KEY = "key-from-the-environment";
    const cwd = join(root, "work");
    await Bun.write(join(cwd, ".keep"), "");
    await Bun.write(join(process.env.RUNNER_TEMP, ".keep"), "");
    scratch = { root, cwd };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratch.root, { recursive: true, force: true });
  });

  return () => scratch;
}

/** A model runtime that only knows the faux provider, scripted with responses. */
export async function fauxRuntime(
  responses: FauxResponseStep[],
  cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
) {
  const faux = fauxProvider({
    models: [{ id: "faux-model", reasoning: true, cost }],
  });
  faux.setResponses(responses);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  // The faux provider accepts any request; authenticate it by API key like a
  // real provider, so a test can see which key reaches the request.
  modelRuntime.registerNativeProvider({
    ...faux.provider,
    auth: { apiKey: envApiKeyAuth("Faux API key", ["FAUX_TEST_API_KEY"]) },
  });
  const model = faux.getModel();
  return { faux, modelRuntime, model: `${model.provider}/${model.id}` };
}

export { readExecutionFile } from "../../src/runner/execution-file";

/** Rules written as in the allowed_tools input, parsed as readRunnerInputs() does. */
export function rules(text: string): ToolRule[] {
  return parseToolRules(text, "allowed_tools");
}
