#!/usr/bin/env bun

import * as core from "@actions/core";
import { retryWithBackoff } from "../utils/retry";
import { GITHUB_API_URL } from "./api/config";

/** The audience of the OIDC token the Token exchange service accepts. */
const OIDC_AUDIENCE = "pi-agent-action";

export class WorkflowValidationSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationSkipError";
  }
}

type AppTokenExchangeErrorResponse = {
  error?: {
    message?: string;
    details?: {
      error_code?: string;
    };
  };
  type?: string;
  message?: string;
};

const WORKFLOW_VALIDATION_ERROR_CODES = new Set([
  "workflow_not_found_on_default_branch",
]);

function getAppTokenExchangeErrorMessage(
  responseJson: AppTokenExchangeErrorResponse,
): string {
  return responseJson.error?.message ?? responseJson.message ?? "Unknown error";
}

function isWorkflowValidationError(
  status: number,
  responseJson: AppTokenExchangeErrorResponse,
): boolean {
  const errorCode = responseJson.error?.details?.error_code;
  if (
    errorCode !== undefined &&
    WORKFLOW_VALIDATION_ERROR_CODES.has(errorCode)
  ) {
    return true;
  }

  if (status !== 401) {
    return false;
  }

  const workflowValidationMessage = "workflow validation failed";
  return [responseJson.message, responseJson.error?.message].some((message) =>
    message?.toLowerCase().includes(workflowValidationMessage),
  );
}

async function getOidcToken(): Promise<string> {
  try {
    const oidcToken = await core.getIDToken(OIDC_AUDIENCE);

    return oidcToken;
  } catch (error) {
    console.error("Failed to get OIDC token:", error);
    throw new Error(
      "Could not fetch an OIDC token. Did you remember to add `id-token: write` to your workflow permissions?",
    );
  }
}

const DEFAULT_PERMISSIONS: Record<string, string> = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
};

export function parseAdditionalPermissions():
  | Record<string, string>
  | undefined {
  const raw = process.env.ADDITIONAL_PERMISSIONS;
  if (!raw || !raw.trim()) {
    return undefined;
  }

  const additional: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    if (key && value) {
      additional[key] = value;
    }
  }

  if (Object.keys(additional).length === 0) {
    return undefined;
  }

  return { ...DEFAULT_PERMISSIONS, ...additional };
}

async function exchangeForAppToken(
  oidcToken: string,
  permissions?: Record<string, string>,
): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${oidcToken}`,
  };
  const fetchOptions: RequestInit = {
    method: "POST",
    headers,
  };

  if (permissions) {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify({ permissions });
  }

  const response = await fetch(
    "https://pi-agent-action.8d7h5sbqdh.workers.dev/api/github/github-app-token-exchange",
    fetchOptions,
  );

  if (!response.ok) {
    const responseJson =
      (await response.json()) as AppTokenExchangeErrorResponse;

    if (isWorkflowValidationError(response.status, responseJson)) {
      const message = getAppTokenExchangeErrorMessage(responseJson);
      core.warning(`Skipping action due to workflow validation: ${message}`);
      console.log(
        "Action skipped due to workflow validation error. This is expected when adding pi-agent-action workflows to new repositories or on PRs with workflow changes. If you're seeing this, your workflow will begin working once you merge your PR.",
      );
      throw new WorkflowValidationSkipError(message);
    }

    const message = getAppTokenExchangeErrorMessage(responseJson);
    console.error(
      `App token exchange failed: ${response.status} ${response.statusText} - ${message}`,
    );
    throw new Error(message);
  }

  const appTokenData = (await response.json()) as {
    token?: string;
    app_token?: string;
  };
  const appToken = appTokenData.token || appTokenData.app_token;

  if (!appToken) {
    throw new Error("App token not found in response");
  }

  return appToken;
}

/**
 * Where the GitHub token came from: the pi-agent-action app (OIDC exchange),
 * or the github_token input.
 */
export type GitHubTokenSource = "app" | "input";

export async function setupGitHubToken(): Promise<string> {
  // Check if GitHub token was provided as override
  const providedToken = process.env.OVERRIDE_GITHUB_TOKEN;

  if (providedToken) {
    console.log("Using provided GITHUB_TOKEN for authentication");
    return providedToken;
  }

  console.log("Requesting OIDC token...");
  const oidcToken = await retryWithBackoff(() => getOidcToken());
  console.log("OIDC token successfully obtained");

  const permissions = parseAdditionalPermissions();

  console.log("Exchanging OIDC token for app token...");
  const appToken = await retryWithBackoff(
    () => exchangeForAppToken(oidcToken, permissions),
    {
      shouldRetry: (error) => !(error instanceof WorkflowValidationSkipError),
    },
  );
  console.log("App token successfully obtained");
  core.setSecret(appToken);

  console.log("Using GITHUB_TOKEN from OIDC");
  return appToken;
}

/** Gets a new app token, as setupGitHubToken() got the first one. */
export type AppTokenMinter = () => Promise<string>;

/**
 * A function that gets a new pi-agent-action app token, for runs longer than
 * the token's hour. It keeps the OIDC request pair from this environment: the
 * Runner removes the pair from process.env before the agent starts
 * (src/runner/run-pi.ts), and core.getIDToken() reads it from there. Undefined
 * without the pair, which the first exchange needed too.
 */
export function appTokenMinter(
  env: NodeJS.ProcessEnv = process.env,
): AppTokenMinter | undefined {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) return undefined;
  const permissions = parseAdditionalPermissions();
  return async () => {
    const oidcToken = await requestOidcToken(requestUrl, requestToken);
    const appToken = await exchangeForAppToken(oidcToken, permissions);
    core.setSecret(appToken);
    return appToken;
  };
}

/** What core.getIDToken() does, with the request pair passed in. */
async function requestOidcToken(
  requestUrl: string,
  requestToken: string,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    throw new Error(
      "Could not fetch an OIDC token: ACTIONS_ID_TOKEN_REQUEST_URL is not a URL",
    );
  }
  url.searchParams.set("audience", OIDC_AUDIENCE);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${requestToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(
      `Could not fetch an OIDC token: ${response.status} ${response.statusText}`,
    );
  }
  const { value } = (await response.json()) as { value?: string };
  if (!value) {
    throw new Error("Could not fetch an OIDC token: the response has none");
  }
  core.setSecret(value);
  return value;
}

/**
 * Revoke an installation token, as the "Revoke app token" step in action.yml
 * does. Throws when GitHub does not confirm.
 */
export async function revokeAppToken(token: string): Promise<void> {
  const response = await fetch(`${GITHUB_API_URL}/installation/token`, {
    method: "DELETE",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 204) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
}
