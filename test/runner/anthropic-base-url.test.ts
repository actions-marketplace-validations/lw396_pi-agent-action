// Exercise the real pi Anthropic transport against scripted Messages SSE.
// Every fetch is intercepted: no provider or gateway account is contacted.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { createModelRuntime } from "../../src/runner/model-runtime";
import { classifyComments } from "../../src/runner/classify-comments";
import { readRunnerInputs, runnerOptions } from "../../src/runner/run-plan";
import { runPi } from "../../src/runner/run-pi";
import { readExecutionFile, useScratch } from "./harness";

const MODEL = "anthropic/claude-sonnet-4-5";
// The Anthropic SDK appends /v1/messages itself, so the base URL has no /v1.
const BASE_URL = "https://gateway.example.test/anthropic";
const MESSAGES_URL = `${BASE_URL}/v1/messages?beta=true`;
const KEY = "gateway-test-access-key";
const getScratch = useScratch();

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

/** Minimal valid Messages SSE: start, one delta per block, stop and usage. */
function messageStream(blocks: Block[]): Response {
  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        id: "msg_gateway",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 1 },
      },
    },
  ];
  for (const [index, block] of blocks.entries()) {
    if (block.type === "text") {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        },
      );
    } else {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: { ...block, input: {} },
        },
        {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        },
      );
    }
    events.push({ type: "content_block_stop", index });
  }
  const toolUse = blocks.some((block) => block.type === "tool_use");
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: toolUse ? "tool_use" : "end_turn" },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  );
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

type CapturedRequest = {
  url: string;
  apiKey: string | null;
  authorization: string | null;
  body: Record<string, unknown>;
};

const AUTH_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
];
let requests: CapturedRequest[];
let responses: Response[];
let restoreFetch: () => void;
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  requests = [];
  responses = [];
  savedEnv = Object.fromEntries(
    AUTH_VARS.map((name) => [name, process.env[name]]),
  );
  for (const name of AUTH_VARS) delete process.env[name];
  const fetchMock = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init);
      requests.push({
        url: request.url,
        apiKey: request.headers.get("x-api-key"),
        authorization: request.headers.get("authorization"),
        body: (await request.json()) as Record<string, unknown>,
      });
      return (
        responses.shift() ??
        Response.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Unexpected request",
            },
          },
          { status: 400 },
        )
      );
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const mock = spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  restoreFetch = () => mock.mockRestore();
});
afterEach(() => {
  restoreFetch();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("ANTHROPIC_BASE_URL", () => {
  test("overrides only anthropic, preserving every built-in model and capability", async () => {
    const original = await createModelRuntime();
    const runtime = await createModelRuntime({
      baseUrls: { anthropic: BASE_URL },
    });
    expect(original.getModel("anthropic", "claude-sonnet-4-5")?.baseUrl).toBe(
      "https://api.anthropic.com",
    );
    expect(runtime.getAllModels("anthropic")).toEqual(
      original
        .getAllModels("anthropic")
        .map((model) => ({ ...model, baseUrl: BASE_URL })),
    );
    for (const provider of [
      "openai",
      "amazon-bedrock",
      "google-vertex",
      "github-copilot",
    ]) {
      expect(runtime.getAllModels(provider)).toEqual(
        original.getAllModels(provider),
      );
    }
    expect(requests).toHaveLength(0);
  });

  test("routes a streaming tool-use conversation through the gateway with the api_key input", async () => {
    const { cwd } = getScratch();
    await Bun.write(join(cwd, "input.txt"), "gateway-tool-result");
    responses.push(
      messageStream([
        {
          type: "tool_use",
          id: "toolu_gateway",
          name: "read",
          input: { path: "input.txt" },
        },
      ]),
      messageStream([{ type: "text", text: "Read the gateway fixture." }]),
    );

    const inputs = readRunnerInputs({
      MODEL,
      API_KEY: KEY,
      ANTHROPIC_BASE_URL: ` ${BASE_URL}/ `,
    });
    const options = runnerOptions(inputs, {
      allowedTools: [],
      acceptEdits: false,
      readOnlyGit: false,
      mcpServers: {},
    });
    const result = await runPi("Read input.txt and report back.", {
      ...options,
      cwd,
    });

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe(MESSAGES_URL);
      expect(request.apiKey).toBe(KEY);
      expect(request.body.model).toBe("claude-sonnet-4-5");
      expect(request.body.stream).toBe(true);
    }
    expect(JSON.stringify(requests[1]!.body.messages)).toContain(
      "gateway-tool-result",
    );
    const records = readExecutionFile(result.executionFile!);
    expect(records.some((record) => record.type === "tool_execution_end")).toBe(
      true,
    );
    expect(JSON.stringify(records)).toContain("Read the gateway fixture.");
    expect(JSON.stringify(records)).not.toContain(KEY);
  });

  test("a failed Runner request stays on the gateway instead of falling back", async () => {
    responses.push(
      Response.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "Gateway rejected request",
          },
        },
        { status: 400 },
      ),
    );
    await expect(
      runPi("Say hello.", {
        model: MODEL,
        apiKey: KEY,
        baseUrls: { anthropic: BASE_URL },
        cwd: getScratch().cwd,
      }),
    ).rejects.toThrow("Gateway rejected request");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(MESSAGES_URL);
  });

  test("classification sends ANTHROPIC_AUTH_TOKEN to the gateway as a bearer token", async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "gateway-bearer-token";
    responses.push(messageStream([{ type: "text", text: "[true, false]" }]));
    const result = await classifyComments(["Fix this loop.", "Test comment"], {
      model: MODEL,
      baseUrls: { anthropic: BASE_URL },
    });
    expect(result).toEqual([true, false]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: MESSAGES_URL,
      authorization: "Bearer gateway-bearer-token",
      apiKey: null,
    });
  });
});
