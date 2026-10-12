// Exercise the real pi OpenAI transport against scripted Responses SSE.
// Every fetch is intercepted: no provider or proxy account is contacted.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createModelRuntime } from "../../src/runner/model-runtime";
import { classifyComments } from "../../src/runner/classify-comments";
import { readRunnerInputs, runnerOptions } from "../../src/runner/run-plan";
import { runPi } from "../../src/runner/run-pi";
import { readExecutionFile, useScratch } from "./harness";

const MODEL = "openai/gpt-5";
const BASE_URL = "https://proxy.example.test/prefix/v1";
const KEY = "proxy-test-access-key";
const getScratch = useScratch();

type WireItem = {
  id: string;
  type: string;
  content?: Array<{ type: string; text: string; annotations: unknown[] }>;
  role?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
};

function textItem(text: string): WireItem {
  return {
    id: "msg_proxy",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

/** Minimal valid SSE, including deltas, item completion and terminal usage. */
function responseStream(items: WireItem[]): Response {
  const events: Array<Record<string, unknown>> = [
    { type: "response.created", response: { id: "resp_proxy" } },
  ];
  for (const [output_index, item] of items.entries()) {
    events.push({ type: "response.output_item.added", output_index, item });
    if (item.type === "message") {
      events.push({
        type: "response.output_text.delta",
        output_index,
        content_index: 0,
        delta: item.content![0]!.text,
      });
    } else if (item.type === "function_call") {
      events.push({
        type: "response.function_call_arguments.delta",
        output_index,
        delta: item.arguments,
      });
    }
    events.push({ type: "response.output_item.done", output_index, item });
  }
  events.push({
    type: "response.completed",
    response: {
      id: "resp_proxy",
      status: "completed",
      output: items,
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        total_tokens: 25,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  return new Response(
    events
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

type CapturedRequest = {
  url: string;
  method: string;
  authorization: string | null;
  body: Record<string, unknown>;
};

let requests: CapturedRequest[];
let responses: Response[];
let restoreFetch: () => void;
let savedKey: string | undefined;
beforeEach(() => {
  requests = [];
  responses = [];
  savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "environment-proxy-access-key";
  const fetchMock = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init);
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        body: (await request.json()) as Record<string, unknown>,
      });
      return (
        responses.shift() ??
        Response.json(
          {
            error: {
              message: "Unexpected request",
              type: "invalid_request_error",
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
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
});

describe("OPENAI_BASE_URL", () => {
  test("leaves the built-in endpoints and static catalog unchanged when unset", async () => {
    const runtime = await createModelRuntime();
    expect(runtime.getModel("openai", "gpt-5")?.baseUrl).toBe(
      "https://api.openai.com/v1",
    );
    expect(await runtime.listCredentials()).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  test("overrides only openai, preserving every built-in model and capability", async () => {
    const original = await createModelRuntime();
    const runtime = await createModelRuntime({ openaiBaseUrl: BASE_URL });
    const before = original.getAllModels("openai");
    const after = runtime.getAllModels("openai");
    expect(after).toEqual(
      before.map((model) => ({ ...model, baseUrl: BASE_URL })),
    );
    for (const provider of ["openai-codex", "anthropic", "opencode", "azure"]) {
      expect(runtime.getAllModels(provider)).toEqual(
        original.getAllModels(provider),
      );
    }
    expect(await runtime.listCredentials()).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  test("rejects invalid runtime configuration before making any request", async () => {
    await expect(
      createModelRuntime({ openaiBaseUrl: "file:///tmp/model" }),
    ).rejects.toThrow("OPENAI_BASE_URL");
    expect(requests).toHaveLength(0);
  });

  test("routes a streaming tool-use conversation and reasoning effort through the proxy", async () => {
    const { cwd } = getScratch();
    await Bun.write(join(cwd, "input.txt"), "proxy-tool-result");
    responses.push(
      responseStream([
        {
          id: "fc_proxy",
          type: "function_call",
          call_id: "call_proxy",
          name: "read",
          arguments: JSON.stringify({ path: "input.txt" }),
        },
      ]),
      responseStream([textItem("Read the proxy fixture.")]),
    );

    const inputs = readRunnerInputs({
      MODEL: `${MODEL}:high`,
      API_KEY: KEY,
      OPENAI_BASE_URL: ` ${BASE_URL}/ `,
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
      expect(request.url).toBe(`${BASE_URL}/responses`);
      expect(request.method).toBe("POST");
      expect(request.authorization).toBe(`Bearer ${KEY}`);
      expect(request.body.model).toBe("gpt-5");
      expect(request.body.stream).toBe(true);
      expect(request.body.reasoning).toMatchObject({ effort: "high" });
    }
    expect(JSON.stringify(requests[1]!.body.input)).toContain(
      "proxy-tool-result",
    );
    expect(JSON.stringify(requests[1]!.body.input)).toContain(
      "function_call_output",
    );
    const records = readExecutionFile(result.executionFile!);
    expect(records.some((record) => record.type === "tool_execution_end")).toBe(
      true,
    );
    expect(JSON.stringify(records)).toContain("Read the proxy fixture.");
    expect(JSON.stringify(records)).not.toContain(KEY);
  });

  test("compaction resolves its summarization model through the same proxy", async () => {
    const { root, cwd } = getScratch();
    const runtime = await createModelRuntime({ openaiBaseUrl: BASE_URL });
    await runtime.setRuntimeApiKey("openai", KEY);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 },
      retry: { enabled: false },
    });
    const agentDir = join(root, "agent");
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model: runtime.getModel("openai", "gpt-5")!,
      modelRuntime: runtime,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "all",
    });
    responses.push(
      responseStream([textItem("First task done.")]),
      responseStream([textItem("Second task done.")]),
      responseStream([textItem("Proxy checkpoint.")]),
      // A split-turn compaction summarizes history and the turn prefix separately.
      responseStream([textItem("Proxy turn checkpoint.")]),
    );
    try {
      await session.bindExtensions({});
      await session.prompt("First task.");
      await session.prompt("Second task.");
      const result = await session.compact();
      expect(result.summary).toContain("Proxy checkpoint.");
      expect(result.summary).toContain("Proxy turn checkpoint.");
      expect(requests).toHaveLength(4);
      for (const request of requests) {
        expect(request.url).toBe(`${BASE_URL}/responses`);
        expect(request.authorization).toBe(`Bearer ${KEY}`);
      }
    } finally {
      session.dispose();
    }
  });

  test("a failed Runner request stays on the proxy instead of falling back", async () => {
    responses.push(
      Response.json(
        {
          error: {
            message: "Proxy rejected request",
            type: "invalid_request_error",
          },
        },
        { status: 400 },
      ),
    );
    await expect(
      runPi("Say hello.", {
        model: MODEL,
        apiKey: KEY,
        openaiBaseUrl: BASE_URL,
        cwd: getScratch().cwd,
      }),
    ).rejects.toThrow("Proxy rejected request");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`${BASE_URL}/responses`);
  });

  test("a fresh classification runtime uses the same endpoint and api_key override", async () => {
    responses.push(responseStream([textItem("[true, false]")]));
    const result = await classifyComments(["Fix this loop.", "Test comment"], {
      model: MODEL,
      apiKey: KEY,
      openaiBaseUrl: BASE_URL,
    });
    expect(result).toEqual([true, false]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: `${BASE_URL}/responses`,
      authorization: `Bearer ${KEY}`,
    });
  });

  test("an OpenAI classify_model uses the endpoint and its environment key even for a different main provider", async () => {
    responses.push(responseStream([textItem("[true]")]));
    const result = await classifyComments(["Fix this loop."], {
      model: "anthropic/claude-sonnet-4",
      apiKey: "main-provider-only-key",
      classifyModel: MODEL,
      openaiBaseUrl: BASE_URL,
    });
    expect(result).toEqual([true]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: `${BASE_URL}/responses`,
      authorization: "Bearer environment-proxy-access-key",
    });
  });

  test("classification keeps its existing failure behavior without falling back to the official API", async () => {
    responses.push(
      Response.json(
        {
          error: {
            message: "Proxy rejected request",
            type: "invalid_request_error",
          },
        },
        { status: 400 },
      ),
    );
    expect(
      await classifyComments(["Fix this loop."], {
        model: MODEL,
        apiKey: KEY,
        openaiBaseUrl: BASE_URL,
      }),
    ).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`${BASE_URL}/responses`);
  });
});
