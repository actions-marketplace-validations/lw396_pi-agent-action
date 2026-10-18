import { afterEach, describe, expect, test } from "bun:test";
import { startTokenBroker, type TokenBroker } from "../src/github/token-broker";
import { currentGitHubToken } from "../src/mcp/github-token";

describe("token broker", () => {
  let broker: TokenBroker | undefined;

  afterEach(() => {
    broker?.stop();
    broker = undefined;
  });

  test("serves the current token to a caller with the key", async () => {
    let token = "token-1";
    broker = startTokenBroker(() => token);
    const env = {
      GITHUB_TOKEN_BROKER_URL: broker.url,
      GITHUB_TOKEN_BROKER_KEY: broker.key,
    };

    expect(new URL(broker.url).hostname).toBe("127.0.0.1");
    await expect(currentGitHubToken(env)).resolves.toBe("token-1");
    token = "token-2";
    await expect(currentGitHubToken(env)).resolves.toBe("token-2");
  });

  test("refuses a caller without the right key", async () => {
    broker = startTokenBroker(() => "secret-token");

    const missing = await fetch(broker.url);
    const wrong = await fetch(broker.url, {
      headers: { Authorization: `Bearer ${"0".repeat(64)}` },
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain("secret-token");
    await expect(
      currentGitHubToken({
        GITHUB_TOKEN_BROKER_URL: broker.url,
        GITHUB_TOKEN_BROKER_KEY: "wrong",
      }),
    ).rejects.toThrow("401");
  });

  test("uses a different key each time", () => {
    const first = startTokenBroker(() => "token");
    const second = startTokenBroker(() => "token");
    try {
      expect(first.key).not.toBe(second.key);
      expect(first.key).toHaveLength(64);
    } finally {
      first.stop();
      second.stop();
    }
  });
});

describe("currentGitHubToken without a broker", () => {
  test("reads GITHUB_TOKEN", async () => {
    await expect(
      currentGitHubToken({ GITHUB_TOKEN: "env-token" }),
    ).resolves.toBe("env-token");
  });

  test("throws without GITHUB_TOKEN", async () => {
    await expect(currentGitHubToken({})).rejects.toThrow(
      "GITHUB_TOKEN environment variable is required",
    );
  });
});
