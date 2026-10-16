import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import { GitHubTokenRefresher } from "../src/github/token-refresh";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("GitHubTokenRefresher", () => {
  let warningSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let refreshers: GitHubTokenRefresher[];

  beforeEach(() => {
    warningSpy = spyOn(core, "warning").mockImplementation(() => {});
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    refreshers = [];
  });

  afterEach(async () => {
    await Promise.all(refreshers.map((refresher) => refresher.stop()));
    warningSpy.mockRestore();
    logSpy.mockRestore();
  });

  function refresher(
    options: ConstructorParameters<typeof GitHubTokenRefresher>[0],
  ) {
    const created = new GitHubTokenRefresher(options);
    refreshers.push(created);
    return created;
  }

  test("replaces the token and tells every listener", async () => {
    const tokens = ["token-2", "token-3"];
    const subject = refresher({
      token: "token-1",
      mint: async () => tokens.shift()!,
    });
    const seen: string[] = [];
    subject.onRefresh((token) => void seen.push(`a:${token}`));
    subject.onRefresh(async (token) => void seen.push(`b:${token}`));

    expect(subject.token).toBe("token-1");
    await expect(subject.refresh()).resolves.toBe(true);
    await subject.refresh();

    expect(subject.token).toBe("token-3");
    expect(seen).toEqual(["a:token-2", "b:token-2", "a:token-3", "b:token-3"]);
  });

  test("refreshes on its own once started", async () => {
    let minted = 0;
    const subject = refresher({
      token: "token-0",
      mint: async () => `token-${++minted}`,
      refreshAfterMs: 20,
    });

    subject.start();
    await wait(70);

    expect(minted).toBeGreaterThanOrEqual(2);
    expect(subject.token).toBe(`token-${minted}`);
  });

  test("keeps the current token and retries when getting a new one fails", async () => {
    let calls = 0;
    const subject = refresher({
      token: "token-1",
      mint: async () => {
        calls++;
        if (calls === 1) throw new Error("exchange down");
        return "token-2";
      },
      refreshAfterMs: 60_000,
      retryAfterMs: 20,
    });

    await expect(subject.refresh()).resolves.toBe(false);
    expect(subject.token).toBe("token-1");
    expect(warningSpy.mock.calls[0]?.[0]).toContain("exchange down");

    await wait(60);
    expect(subject.token).toBe("token-2");
  });

  test("still uses the new token when a listener fails", async () => {
    const subject = refresher({
      token: "token-1",
      mint: async () => "token-2",
    });
    const seen: string[] = [];
    subject.onRefresh(() => {
      throw new Error("git is locked");
    });
    subject.onRefresh((token) => void seen.push(token));

    await expect(subject.refresh()).resolves.toBe(true);

    expect(subject.token).toBe("token-2");
    expect(seen).toEqual(["token-2"]);
    expect(warningSpy.mock.calls[0]?.[0]).toContain("git is locked");
  });

  test("revokes a replaced token after the grace period, and never the current one", async () => {
    const revoked: string[] = [];
    const subject = refresher({
      token: "token-1",
      mint: async () => "token-2",
      revoke: async (token) => void revoked.push(token),
      revokeAfterMs: 20,
    });

    await subject.refresh();
    expect(revoked).toEqual([]);
    await wait(50);

    expect(revoked).toEqual(["token-1"]);
  });

  test("stop() revokes replaced tokens at once and keeps the current one", async () => {
    const revoked: string[] = [];
    const subject = refresher({
      token: "token-1",
      mint: async () => "token-2",
      revoke: async (token) => void revoked.push(token),
      revokeAfterMs: 60_000,
    });

    await subject.refresh();
    await subject.stop();

    expect(revoked).toEqual(["token-1"]);
    expect(subject.token).toBe("token-2");
  });

  test("does not refresh after stop()", async () => {
    let minted = 0;
    const subject = refresher({
      token: "token-0",
      mint: async () => `token-${++minted}`,
      refreshAfterMs: 10,
    });

    subject.start();
    await subject.stop();
    await wait(40);

    expect(minted).toBe(0);
  });

  test("shares one refresh between concurrent calls", async () => {
    let minted = 0;
    const subject = refresher({
      token: "token-0",
      mint: async () => {
        await wait(10);
        return `token-${++minted}`;
      },
    });

    await Promise.all([subject.refresh(), subject.refresh()]);

    expect(minted).toBe(1);
  });
});
