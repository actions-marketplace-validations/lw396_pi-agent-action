import { randomBytes, timingSafeEqual } from "node:crypto";

/** Where the action's MCP servers get the current GitHub token. */
export type TokenBrokerAddress = {
  url: string;
  /** Sent as a bearer token; anything else gets 401. */
  key: string;
};

export type TokenBroker = TokenBrokerAddress & {
  stop(): void;
};

/**
 * Serve the current GitHub token on 127.0.0.1 to the action's MCP servers.
 * They are separate processes started with a fixed environment, so a token
 * put there at start would expire after an hour; with the broker they get
 * the token the refresher holds at each call (src/github/token-refresh.ts).
 * Nothing is written to disk. Only a caller with the key gets an answer, and
 * the key is only in the MCP servers' environment, where the token itself
 * was before.
 */
export function startTokenBroker(currentToken: () => string): TokenBroker {
  const key = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${key}`);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const given = Buffer.from(request.headers.get("authorization") ?? "");
      const authorized =
        given.length === expected.length && timingSafeEqual(given, expected);
      if (!authorized) return new Response(null, { status: 401 });
      if (request.method !== "GET") return new Response(null, { status: 405 });
      return new Response(currentToken(), {
        headers: { "Cache-Control": "no-store" },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    key,
    stop: () => void server.stop(true),
  };
}
