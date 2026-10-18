/**
 * The GitHub token for one call of an MCP server tool: from the action's
 * token broker when the server was given one (src/github/token-broker.ts), so
 * a run longer than the app token's hour keeps working, otherwise from
 * GITHUB_TOKEN.
 */
export async function currentGitHubToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const brokerUrl = env.GITHUB_TOKEN_BROKER_URL;
  if (brokerUrl) {
    const response = await fetch(brokerUrl, {
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN_BROKER_KEY ?? ""}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(
        `Could not get the GitHub token from the action: ${response.status}`,
      );
    }
    const token = (await response.text()).trim();
    if (token) return token;
    throw new Error("Could not get the GitHub token from the action: empty");
  }
  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is required");
  }
  return token;
}
