import * as core from "@actions/core";

/** Told about each new token, in the order the listeners were added. */
export type TokenListener = (token: string) => void | Promise<void>;

export type TokenRefreshOptions = {
  /** The token the run started with. */
  token: string;
  /** Gets a new token. */
  mint: () => Promise<string>;
  /** Revokes a replaced token. Without it, replaced tokens expire on their own. */
  revoke?: (token: string) => Promise<void>;
  /**
   * How long a token is used before it is replaced. App installation tokens
   * expire after an hour, so the default leaves 15 minutes for retries.
   */
  refreshAfterMs?: number;
  /** How long to wait before trying again when getting a new token fails. */
  retryAfterMs?: number;
  /**
   * How long a replaced token stays valid, for a git push or API call that
   * started with it just before the refresh.
   */
  revokeAfterMs?: number;
};

const MINUTE = 60_000;

/**
 * Keeps the pi-agent-action app token valid for a run longer than the
 * token's hour: replaces it every refreshAfterMs and tells the listeners,
 * which update the places that hold it (git, the environment, the API
 * clients). A failure leaves the current token in place and is retried.
 */
export class GitHubTokenRefresher {
  readonly #mint: () => Promise<string>;
  readonly #revoke?: (token: string) => Promise<void>;
  readonly #refreshAfterMs: number;
  readonly #retryAfterMs: number;
  readonly #revokeAfterMs: number;
  readonly #listeners: TokenListener[] = [];
  /** Replaced tokens not revoked yet, with the timer that revokes each. */
  readonly #replaced = new Map<string, ReturnType<typeof setTimeout>>();
  #token: string;
  #timer?: ReturnType<typeof setTimeout>;
  #refreshing?: Promise<boolean>;
  #stopped = false;

  constructor(options: TokenRefreshOptions) {
    this.#token = options.token;
    this.#mint = options.mint;
    this.#revoke = options.revoke;
    this.#refreshAfterMs = options.refreshAfterMs ?? 45 * MINUTE;
    this.#retryAfterMs = options.retryAfterMs ?? MINUTE;
    this.#revokeAfterMs = options.revokeAfterMs ?? 5 * MINUTE;
  }

  /** The token to use now. */
  get token(): string {
    return this.#token;
  }

  onRefresh(listener: TokenListener): void {
    this.#listeners.push(listener);
  }

  /** Schedule the first refresh. */
  start(): void {
    if (this.#stopped) return;
    this.#schedule(this.#refreshAfterMs);
  }

  /**
   * Replace the token now. Resolves to whether it was replaced; a failure is
   * reported as a warning, not thrown. Concurrent calls share one refresh.
   */
  refresh(): Promise<boolean> {
    this.#refreshing ??= this.#replace().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  /**
   * Stop refreshing and revoke every replaced token now. The current token is
   * left valid: the steps after this one use it, and action.yml revokes it.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#refreshing;
    const replaced = [...this.#replaced.keys()];
    for (const timer of this.#replaced.values()) clearTimeout(timer);
    await Promise.all(replaced.map((token) => this.#revokeReplaced(token)));
  }

  async #replace(): Promise<boolean> {
    let token: string;
    try {
      token = await this.#mint();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(
        `Could not refresh the GitHub token, retrying in ${Math.round(this.#retryAfterMs / 1000)}s: ${message}`,
      );
      this.#schedule(this.#retryAfterMs);
      return false;
    }
    if (this.#stopped) {
      // stop() came while the token was minted: nothing will use it.
      await this.#revokeReplaced(token);
      return false;
    }
    const previous = this.#token;
    this.#token = token;
    console.log("Refreshed the GitHub token");
    for (const listener of this.#listeners) {
      try {
        await listener(token);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Could not apply the refreshed GitHub token: ${message}`);
      }
    }
    if (this.#revoke && previous !== token) {
      const timer = setTimeout(
        () => void this.#revokeReplaced(previous),
        this.#revokeAfterMs,
      );
      timer.unref?.();
      this.#replaced.set(previous, timer);
    }
    this.#schedule(this.#refreshAfterMs);
    return true;
  }

  async #revokeReplaced(token: string): Promise<void> {
    this.#replaced.delete(token);
    if (!this.#revoke) return;
    try {
      await this.#revoke(token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // It still expires within the hour.
      console.log(`Could not revoke a replaced GitHub token: ${message}`);
    }
  }

  #schedule(delayMs: number): void {
    clearTimeout(this.#timer);
    if (this.#stopped) return;
    this.#timer = setTimeout(() => void this.refresh(), delayMs);
    // A pending refresh must not keep the process alive.
    this.#timer.unref?.();
  }
}
