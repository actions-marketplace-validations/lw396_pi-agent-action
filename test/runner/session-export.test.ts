// The redacted session export (issue #25): the Runner's in-memory pi session
// written as pi's JSONL, and an offline HTML page made from that file alone.
import * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { writeSessionExport } from "../../src/runner/session-export";
import { collectSecretValues } from "../../src/runner/secret-values";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-export-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The session data the HTML page embeds, base64-encoded JSON. */
export async function embeddedSessionData(htmlPath: string) {
  const html = await Bun.file(htmlPath).text();
  const match = html.match(
    /<script id="session-data" type="application\/json">([^<]*)<\/script>/,
  );
  expect(match).not.toBeNull();
  return JSON.parse(Buffer.from(match![1]!, "base64").toString("utf-8")) as {
    header: { type: string; id: string };
    entries: SessionEntry[];
    leafId: string | null;
  };
}

function assistant(text: string) {
  return {
    ...fauxAssistantMessage(text),
    api: "faux",
    provider: "faux",
    model: "faux-model",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 18,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    },
  };
}

// Test values only.
const SHORT_SECRET = "sk9-short";
const UNKNOWN_FORMAT_SECRET = "zq7Vh2LmP0aB9xYtW4";
const GITHUB_TOKEN = `ghp_${"a1B2c3D4e5".repeat(3)}abcdef`;
const BASE64_SECRET = Buffer.from(UNKNOWN_FORMAT_SECRET).toString("base64");
const URL_ENCODED_SECRET = encodeURIComponent(`${UNKNOWN_FORMAT_SECRET}/+=`);
const IMAGE_DATA = "iVBORw0KGgoIMAGEDATAMARKER";
const EXTENSION_PAYLOAD = "EXTENSION_PAYLOAD_MARKER";
const SIGNATURE = "OPAQUE_SIGNATURE_MARKER";
const MALICIOUS_HTML =
  '<script>alert("pwned")</script><img src=x onerror=alert(1)>';

/** A session with every kind of content the export has to handle. */
function sessionWithSecrets() {
  const session = SessionManager.inMemory("/work");
  session.appendMessage({
    role: "system",
    content: `You are a CI agent. Key: ${SHORT_SECRET}`,
    sections: { env: `OPAQUE_VALUE=${UNKNOWN_FORMAT_SECRET}` },
    timestamp: 1,
  });
  session.appendMessage({
    role: "user",
    content: [
      { type: "text", text: `Deploy with ${GITHUB_TOKEN}` },
      { type: "image", data: IMAGE_DATA, mimeType: "image/png" },
    ],
    timestamp: 2,
  });
  session.appendMessage({
    ...assistant(""),
    content: [
      {
        type: "thinking",
        thinking: `Planning the deploy; the key is ${SHORT_SECRET}.`,
        thinkingSignature: SIGNATURE,
      },
      { type: "text", text: `Running the tests. ${MALICIOUS_HTML}` },
      {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: {
          command: `echo deploying ${URL_ENCODED_SECRET}`,
          nested: { list: [{ value: BASE64_SECRET }], [SHORT_SECRET]: 1 },
        },
        thoughtSignature: SIGNATURE,
      },
    ],
    stopReason: "toolUse",
  });
  session.appendMessage({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: [
      { type: "text", text: `tests passed: 12\ntoken=${SHORT_SECRET}` },
      { type: "image", data: IMAGE_DATA, mimeType: "image/png" },
    ],
    details: { payload: EXTENSION_PAYLOAD },
    isError: false,
    timestamp: 4,
  });
  const kept = session.appendMessage(assistant("Deployed."));
  session.appendCompaction(
    `Summary: tests passed, deployed with ${SHORT_SECRET}.`,
    kept,
    1234,
    { payload: EXTENSION_PAYLOAD },
  );
  session.appendCustomEntry("some-extension", {
    payload: EXTENSION_PAYLOAD,
    key: SHORT_SECRET,
  });
  session.appendCustomMessageEntry(
    "some-extension",
    `Extension note ${UNKNOWN_FORMAT_SECRET}`,
    true,
    { payload: EXTENSION_PAYLOAD },
  );
  session.appendMessage({
    ...assistant(""),
    stopReason: "error",
    errorMessage: `401: bad key ${SHORT_SECRET}`,
    // A field the export does not know.
    providerExtra: { payload: EXTENSION_PAYLOAD },
  } as Parameters<SessionManager["appendMessage"]>[0]);
  return session;
}

/** The session with an entry and a message of kinds the export does not know. */
function sessionWithUnknownKinds() {
  const session = sessionWithSecrets();
  const unknown = [
    {
      type: "telemetry",
      id: "u1",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      payload: EXTENSION_PAYLOAD,
    },
    {
      type: "message",
      id: "u2",
      parentId: "u1",
      timestamp: new Date(0).toISOString(),
      message: { role: "telemetry", payload: EXTENSION_PAYLOAD, timestamp: 9 },
    },
  ] as unknown as SessionEntry[];
  return {
    getSessionId: () => session.getSessionId(),
    getCwd: () => session.getCwd(),
    getBranch: () => [...session.getBranch(), ...unknown],
  };
}

describe("writeSessionExport", () => {
  beforeEach(() => {
    collectSecretValues({
      DEPLOY_TOKEN: SHORT_SECRET,
      OPAQUE_VALUE: UNKNOWN_FORMAT_SECRET,
    });
  });

  afterEach(() => {
    collectSecretValues({});
  });

  test("leaves no secret, image, signature or extension payload in either file", async () => {
    const result = await writeSessionExport(sessionWithUnknownKinds(), dir);

    const jsonl = await Bun.file(result.jsonl!).text();
    const html = await Bun.file(result.html!).text();
    // Base64 is not redaction: the page's embedded data is checked decoded.
    const embedded = JSON.stringify(await embeddedSessionData(result.html!));
    for (const published of [jsonl, html, embedded]) {
      for (const leak of [
        SHORT_SECRET,
        UNKNOWN_FORMAT_SECRET,
        GITHUB_TOKEN,
        BASE64_SECRET,
        URL_ENCODED_SECRET,
        IMAGE_DATA,
        EXTENSION_PAYLOAD,
        SIGNATURE,
      ]) {
        expect(published).not.toContain(leak);
      }
    }
  });

  test("keeps the run's process, with placeholders for what it leaves out", async () => {
    const result = await writeSessionExport(sessionWithSecrets(), dir);
    const jsonl = await Bun.file(result.jsonl!).text();

    for (const kept of [
      "Planning the deploy",
      "Running the tests.",
      '"name":"bash"',
      "echo deploying",
      "tests passed: 12",
      "Summary: tests passed",
      "Extension note",
      "401: bad key",
      '"tokensBefore":1234',
      '"customType":"some-extension"',
    ]) {
      expect(jsonl).toContain(kept);
    }
    expect(jsonl).toContain("[REDACTED]");
    expect(jsonl).toContain("[image omitted from the export (image/png)]");
    expect(jsonl).toContain("[extension data omitted from the export]");
    // Every entry of the branch is there, in order and linked.
    const entries = SessionManager.open(result.jsonl!).getBranch();
    expect(entries.map((entry) => entry.type)).toEqual([
      "message",
      "message",
      "message",
      "message",
      "message",
      "compaction",
      "custom",
      "custom_message",
      "message",
    ]);
  });

  test("replaces entries and messages of kinds it does not know with placeholders", async () => {
    const result = await writeSessionExport(sessionWithUnknownKinds(), dir);

    const entries = SessionManager.open(result.jsonl!).getBranch();
    // custom_message entries, the kind pi's HTML page shows, so the page
    // says what was left out, as the JSONL does.
    const placeholder = {
      type: "custom_message",
      customType: "pi-agent-action/omitted",
      display: true,
    };
    expect(entries.slice(-2)).toMatchObject([
      { ...placeholder, id: "u1", content: expect.stringContaining("entry") },
      { ...placeholder, id: "u2", content: expect.stringContaining("message") },
    ]);
    expect(JSON.stringify(entries)).not.toContain("telemetry");
    const embedded = await embeddedSessionData(result.html!);
    expect(embedded.entries.slice(-2)).toEqual(entries.slice(-2));
  });

  test("fails without a file, and with a redacted diagnostic, when it cannot write", async () => {
    const warning = spyOn(core, "warning").mockImplementation(() => {});
    // A file where the export directory should be.
    const blocked = join(dir, `blocked-${SHORT_SECRET}`);
    await Bun.write(blocked, "");

    try {
      const result = await writeSessionExport(sessionWithSecrets(), blocked);

      expect(result).toEqual({});
      expect(readdirSync(dir)).toEqual([`blocked-${SHORT_SECRET}`]);
      expect(warning).toHaveBeenCalledTimes(1);
      const message = String(warning.mock.calls[0]![0]);
      expect(message).toStartWith("The session export failed");
      expect(message).not.toContain(SHORT_SECRET);
    } finally {
      warning.mockRestore();
    }
  });

  test("keeps the JSONL, and no partial page, when the HTML export fails", async () => {
    const warning = spyOn(core, "warning").mockImplementation(() => {});
    // The page's file name is taken by a directory.
    mkdirSync(join(dir, "pi-session.html.partial", "x"), { recursive: true });

    try {
      const result = await writeSessionExport(sessionWithSecrets(), dir);

      expect(result).toEqual({ jsonl: join(dir, "pi-session.jsonl") });
      expect(readdirSync(dir)).not.toContain("pi-session.html");
      expect(String(warning.mock.calls[0]![0])).toStartWith(
        "The session's HTML export failed",
      );
    } finally {
      warning.mockRestore();
    }
  });

  test("keeps model-written HTML as data, out of the page's markup", async () => {
    const result = await writeSessionExport(sessionWithSecrets(), dir);

    const html = await Bun.file(result.html!).text();
    expect(html).not.toContain("pwned");
    expect(html).not.toContain("onerror=alert");
    // It is shown as text: pi's page renders HTML in messages verbatim
    // (test/pi-sdk/session-export.test.ts).
    expect(JSON.stringify(await embeddedSessionData(result.html!))).toContain(
      "pwned",
    );
  });

  test("writes the current branch as JSONL pi reads, and HTML made from it", async () => {
    const session = SessionManager.inMemory("/work");
    session.appendMessage({
      role: "user",
      content: "Fix the bug.",
      timestamp: 1,
    });
    session.appendMessage(assistant("Fixed it."));

    const result = await writeSessionExport(session, dir);

    expect(result.jsonl).toBe(join(dir, "pi-session.jsonl"));
    expect(result.html).toBe(join(dir, "pi-session.html"));

    const reopened = SessionManager.open(result.jsonl!);
    expect(reopened.getHeader()?.id).toBe(session.getSessionId());
    const messages = reopened
      .getBranch()
      .map((entry) => (entry.type === "message" ? entry.message : undefined));
    expect(messages.map((message) => message?.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(JSON.stringify(messages)).toContain("Fix the bug.");
    expect(JSON.stringify(messages)).toContain("Fixed it.");
    // Usage is kept.
    expect(JSON.stringify(messages)).toContain('"totalTokens":18');

    const data = await embeddedSessionData(result.html!);
    expect(data.header.id).toBe(session.getSessionId());
    expect(data.entries).toEqual(reopened.getEntries());
    expect(data.leafId).toBe(reopened.getLeafId());

    // Readable offline: nothing is loaded from elsewhere, and its Content
    // Security Policy keeps a model-written remote image from loading.
    const html = await Bun.file(result.html!).text();
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).toMatch(
      /<head>\n  <meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*img-src data: blob:;/,
    );
    expect(readdirSync(dir).sort()).toEqual([
      "pi-session.html",
      "pi-session.jsonl",
    ]);
  });
});
