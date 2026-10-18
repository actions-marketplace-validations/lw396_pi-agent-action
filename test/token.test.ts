import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import * as core from "@actions/core";
import {
  appTokenMinter,
  revokeAppToken,
  setupGitHubToken,
  WorkflowValidationSkipError,
} from "../src/github/token";

describe("setupGitHubToken", () => {
  let originalOverrideToken: string | undefined;
  let originalAdditionalPermissions: string | undefined;
  let getIDTokenSpy: any;
  let setSecretSpy: any;
  let warningSpy: any;
  let fetchSpy: any;
  let setTimeoutSpy: any;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    originalOverrideToken = process.env.OVERRIDE_GITHUB_TOKEN;
    originalAdditionalPermissions = process.env.ADDITIONAL_PERMISSIONS;
    delete process.env.OVERRIDE_GITHUB_TOKEN;
    delete process.env.ADDITIONAL_PERMISSIONS;

    getIDTokenSpy = spyOn(core, "getIDToken").mockResolvedValue("oidc-token");
    setSecretSpy = spyOn(core, "setSecret").mockImplementation(() => {});
    warningSpy = spyOn(core, "warning").mockImplementation(() => {});
    fetchSpy = spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ token: "app-token" }), {
        status: 200,
        statusText: "OK",
      }),
    );
    setTimeoutSpy = spyOn(global, "setTimeout").mockImplementation(((
      handler: any,
    ) => {
      handler();
      return 0 as any;
    }) as any);
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalOverrideToken === undefined) {
      delete process.env.OVERRIDE_GITHUB_TOKEN;
    } else {
      process.env.OVERRIDE_GITHUB_TOKEN = originalOverrideToken;
    }

    if (originalAdditionalPermissions === undefined) {
      delete process.env.ADDITIONAL_PERMISSIONS;
    } else {
      process.env.ADDITIONAL_PERMISSIONS = originalAdditionalPermissions;
    }

    getIDTokenSpy.mockRestore();
    setSecretSpy.mockRestore();
    warningSpy.mockRestore();
    fetchSpy.mockRestore();
    setTimeoutSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test("returns app token from OIDC exchange", async () => {
    await expect(setupGitHubToken()).resolves.toBe("app-token");

    expect(getIDTokenSpy).toHaveBeenCalledWith("pi-agent-action");
    expect(setSecretSpy).toHaveBeenCalledWith("app-token");
  });

  test("exchanges the OIDC token at the project's token exchange service", async () => {
    await setupGitHubToken();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://pi-agent-action.8d7h5sbqdh.workers.dev/api/github/github-app-token-exchange",
    );
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer oidc-token");
  });

  test("skips without retrying when workflow is missing from default branch", async () => {
    const message =
      "Workflow validation failed. The workflow file must exist and have identical content to the version on the repository's default branch.";
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message,
            details: {
              error_code: "workflow_not_found_on_default_branch",
            },
          },
        }),
        { status: 401, statusText: "Unauthorized" },
      ),
    );

    await expect(setupGitHubToken()).rejects.toBeInstanceOf(
      WorkflowValidationSkipError,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledWith(
      `Skipping action due to workflow validation: ${message}`,
    );
    const logged = consoleLogSpy.mock.calls.flat().join("\n");
    expect(logged).toContain("workflow validation");
    expect(logged).not.toMatch(/claude|anthropic/i);
  });

  test("skips without retrying when workflow validation message has no error code", async () => {
    const message =
      "Workflow validation failed. The workflow file must exist and have identical content to the version on the repository's default branch.";
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message,
          },
        }),
        { status: 401, statusText: "Unauthorized" },
      ),
    );

    await expect(setupGitHubToken()).rejects.toBeInstanceOf(
      WorkflowValidationSkipError,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledWith(
      `Skipping action due to workflow validation: ${message}`,
    );
  });

  test("retries ordinary token exchange errors instead of skipping", async () => {
    const message = "Bad credentials";
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message,
            },
          }),
          { status: 401, statusText: "Unauthorized" },
        ),
    );

    await expect(setupGitHubToken()).rejects.toThrow(message);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(warningSpy).not.toHaveBeenCalled();
  });

  test("does not skip message-only workflow validation errors with unexpected status", async () => {
    const message =
      "Workflow validation failed. The workflow file must exist and have identical content to the version on the repository's default branch.";
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message,
            },
          }),
          { status: 500, statusText: "Internal Server Error" },
        ),
    );

    await expect(setupGitHubToken()).rejects.toThrow(message);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(warningSpy).not.toHaveBeenCalled();
  });
});

describe("appTokenMinter", () => {
  let fetchSpy: any;
  let setSecretSpy: any;

  beforeEach(() => {
    setSecretSpy = spyOn(core, "setSecret").mockImplementation(() => {});
    fetchSpy = spyOn(global, "fetch").mockImplementation((async (
      input: string | URL,
    ) =>
      String(input).startsWith("https://oidc.example")
        ? Response.json({ value: "oidc-token" })
        : Response.json({ token: "new-app-token" })) as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    setSecretSpy.mockRestore();
  });

  test("is undefined without the OIDC request pair", () => {
    expect(appTokenMinter({})).toBeUndefined();
  });

  test("keeps the OIDC request pair, so it works after the Runner hides it", async () => {
    const env: NodeJS.ProcessEnv = {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token?api-version=2",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    };
    const mint = appTokenMinter(env)!;
    delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

    await expect(mint()).resolves.toBe("new-app-token");

    const [oidcUrl, oidcInit] = fetchSpy.mock.calls[0];
    const url = new URL(String(oidcUrl));
    expect(url.searchParams.get("api-version")).toBe("2");
    expect(url.searchParams.get("audience")).toBe("pi-agent-action");
    expect(oidcInit.headers.Authorization).toBe("Bearer request-token");
    const [exchangeUrl, exchangeInit] = fetchSpy.mock.calls[1];
    expect(exchangeUrl).toBe(
      "https://pi-agent-action.8d7h5sbqdh.workers.dev/api/github/github-app-token-exchange",
    );
    expect(exchangeInit.headers.Authorization).toBe("Bearer oidc-token");
    expect(setSecretSpy).toHaveBeenCalledWith("new-app-token");
  });

  test("throws when the OIDC token request fails", async () => {
    fetchSpy.mockImplementation(
      async () => new Response("", { status: 403, statusText: "Forbidden" }),
    );
    const mint = appTokenMinter({
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    })!;

    await expect(mint()).rejects.toThrow("403");
  });
});

describe("revokeAppToken", () => {
  let fetchSpy: any;

  afterEach(() => fetchSpy.mockRestore());

  test("deletes the installation token with that token", async () => {
    fetchSpy = spyOn(global, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await revokeAppToken("old-token");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toEndWith("/installation/token");
    expect(init.method).toBe("DELETE");
    expect(init.headers.Authorization).toBe("Bearer old-token");
  });

  test("throws when GitHub does not confirm", async () => {
    fetchSpy = spyOn(global, "fetch").mockResolvedValue(
      new Response(null, { status: 401, statusText: "Unauthorized" }),
    );

    await expect(revokeAppToken("old-token")).rejects.toThrow("401");
  });
});
