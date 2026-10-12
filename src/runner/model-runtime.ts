import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type ModelRuntimeOptions = {
  /** OPENAI_BASE_URL: override only the openai provider, not openai-codex. */
  openaiBaseUrl?: string;
};

/** Validate without echoing a potentially credential-bearing URL in errors. */
export function parseOpenAIBaseUrl(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      "OPENAI_BASE_URL must be an absolute HTTP(S) API base URL.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "OPENAI_BASE_URL must be an HTTP(S) API base URL without credentials, a query string or a fragment.",
    );
  }
  return url.href.replace(/\/+$/, "");
}

/**
 * The model runtime the action uses: provider keys come from the environment
 * (or setRuntimeApiKey), every credential stays in memory, and only pi's
 * static model catalog is used. Endpoint overrides apply before model selection.
 */
export async function createModelRuntime(
  options: ModelRuntimeOptions = {},
): Promise<ModelRuntime> {
  const baseUrl = parseOpenAIBaseUrl(options.openaiBaseUrl);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), // never reads or writes auth.json
    modelsPath: null, // no models.json
    refreshOnCreate: false, // static catalog only, no network at startup
  });
  if (baseUrl) {
    // Preserve the built-in catalog, authentication and API implementations.
    // Failed requests stay on this endpoint; there is no official-API fallback.
    runtime.registerProvider("openai", { baseUrl });
  }
  return runtime;
}
