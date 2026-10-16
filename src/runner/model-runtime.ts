import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * The providers whose endpoint a workflow can override, and the env var that
 * does it. Each override replaces only that provider's base URL: openai's
 * does not touch openai-codex or Azure, anthropic's does not touch Bedrock or
 * Vertex. Each provider's path convention differs, so add one only after
 * checking where its transport appends the API path.
 */
const BASE_URL_ENV = {
  openai: "OPENAI_BASE_URL",
  anthropic: "ANTHROPIC_BASE_URL",
} as const;

export type BaseUrlProvider = keyof typeof BASE_URL_ENV;

export type ModelRuntimeOptions = {
  /** Endpoint overrides, by provider, from the BASE_URL_ENV variables. */
  baseUrls?: Partial<Record<BaseUrlProvider, string>>;
};

const PROVIDERS = Object.keys(BASE_URL_ENV) as BaseUrlProvider[];

/**
 * Validate an endpoint override. Errors name the variable but never echo the
 * value, which may carry credentials.
 */
function parseBaseUrl(
  name: string,
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) API base URL.`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${name} must be an HTTP(S) API base URL without credentials, a query string or a fragment.`,
    );
  }
  return url.href.replace(/\/+$/, "");
}

/** Validate each provider's override, looked up by provider and env var. */
function parseBaseUrls(
  lookup: (provider: BaseUrlProvider, name: string) => string | undefined,
): Partial<Record<BaseUrlProvider, string>> {
  const baseUrls: Partial<Record<BaseUrlProvider, string>> = {};
  for (const provider of PROVIDERS) {
    const name = BASE_URL_ENV[provider];
    const baseUrl = parseBaseUrl(name, lookup(provider, name));
    if (baseUrl) baseUrls[provider] = baseUrl;
  }
  return baseUrls;
}

/** Read every supported endpoint override from the environment. */
export function readBaseUrls(
  env: NodeJS.ProcessEnv,
): Partial<Record<BaseUrlProvider, string>> {
  return parseBaseUrls((_, name) => env[name]);
}

/**
 * The model runtime the action uses: provider keys come from the environment
 * (or setRuntimeApiKey), every credential stays in memory, and only pi's
 * static model catalog is used. Endpoint overrides apply before model selection.
 */
export async function createModelRuntime(
  options: ModelRuntimeOptions = {},
): Promise<ModelRuntime> {
  const baseUrls = parseBaseUrls((provider) => options.baseUrls?.[provider]);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), // never reads or writes auth.json
    modelsPath: null, // no models.json
    refreshOnCreate: false, // static catalog only, no network at startup
  });
  for (const [provider, baseUrl] of Object.entries(baseUrls)) {
    // Preserve the built-in catalog, authentication and API implementations.
    // Failed requests stay on this endpoint; there is no official-API fallback.
    runtime.registerProvider(provider, { baseUrl });
  }
  return runtime;
}
