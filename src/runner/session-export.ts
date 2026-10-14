import * as core from "@actions/core";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { join } from "path";
import {
  CURRENT_SESSION_VERSION,
  type SessionEntry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "../github/utils/sanitizer";
import { redactNamedSecretValues } from "./secret-values";

/**
 * The export_session input: the Runner's session, redacted, as pi's JSONL
 * and as an HTML page made from that JSONL alone.
 *
 * The export is a projection, not a copy: each entry and message kind pi
 * 1.2.0 writes is rebuilt field by field, every string redacted and cut to
 * a bounded length. Images, extension data and kinds the export does not
 * know are replaced by a placeholder saying so. The raw session is never
 * written to disk: it lives in the Runner's in-memory SessionManager.
 */

/** Where the files go, under the directory writeSessionExport() is given. */
const SESSION_JSONL = "pi-session.jsonl";
const SESSION_HTML = "pi-session.html";

/** The files an export produced. A file that failed is left out. */
export type SessionExport = { jsonl?: string; html?: string };

/** Strings longer than this are cut, after redaction. */
const MAX_TEXT_LENGTH = 50_000;
/** Nesting deeper than this, in tool arguments and the like, is cut. */
const MAX_DEPTH = 32;

/**
 * customType of the placeholders for entries and messages left out. They
 * are custom_message entries, the kind pi's HTML page shows.
 */
const OMITTED_TYPE = "pi-agent-action/omitted";
const OMITTED_DATA = "[extension data omitted from the export]";
const OMITTED_ENTRY =
  "[an entry of a kind the export does not know was omitted]";
const OMITTED_MESSAGE =
  "[a message of a kind the export does not know was omitted]";
const OMITTED_CONTENT =
  "[content of a kind the export does not know was omitted]";
const OMITTED_THINKING = "[redacted thinking omitted from the export]";
const OMITTED_NESTING = "[nested data omitted from the export]";

/** A JSON value as the export writes it; undefined fields are left out. */
type Json =
  | string
  | number
  | boolean
  | null
  | undefined
  | Json[]
  | { [key: string]: Json };
type ExportedSession = Pick<
  SessionManager,
  "getSessionId" | "getCwd" | "getBranch"
>;

/**
 * The page may not load anything: a model-written `![](https://...)` would
 * otherwise be fetched when the page is opened. Its scripts and styles are
 * inline, and its own images are data: URLs.
 */
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'";

/**
 * Export the session's current branch to `dir`, outside the checkout. Never
 * throws: a file that cannot be made is removed and logged, redacted, and
 * left out of the result, so no partial or earlier file looks like a
 * finished one.
 */
export async function writeSessionExport(
  session: ExportedSession,
  dir: string,
): Promise<SessionExport> {
  const jsonl = join(dir, SESSION_JSONL);
  const html = join(dir, SESSION_HTML);
  try {
    await mkdir(dir, { recursive: true });
    await Promise.all([rm(jsonl, { force: true }), rm(html, { force: true })]);
    await writeWhole(jsonl, (partial) =>
      writeFile(partial, serializeSession(session)),
    );
  } catch (error) {
    core.warning(`The session export failed: ${diagnostic(error)}`);
    return {};
  }

  try {
    const exportFromFile = await htmlExporter();
    // Only the redacted JSONL, with a built-in theme: no custom tool
    // renderer, no extension and no user theme is involved.
    await writeWhole(html, async (partial) => {
      await exportFromFile(jsonl, { outputPath: partial, themeName: "dark" });
      await writeFile(
        partial,
        withContentSecurityPolicy(await readFile(partial, "utf-8")),
      );
    });
  } catch (error) {
    core.warning(`The session's HTML export failed: ${diagnostic(error)}`);
    return { jsonl };
  }
  return { jsonl, html };
}

function withContentSecurityPolicy(page: string): string {
  const head = "<head>";
  if (!page.includes(head)) throw new Error("the HTML page has no <head>");
  return page.replace(
    head,
    `${head}\n  <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`,
  );
}

/** Write a file under a temporary name, renamed only once it is complete. */
async function writeWhole(
  path: string,
  write: (partial: string) => Promise<unknown>,
): Promise<void> {
  const partial = `${path}.partial`;
  try {
    await write(partial);
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

type ExportFromFile = (
  inputPath: string,
  options: { outputPath: string; themeName: string },
) => Promise<string>;

/**
 * pi's own HTML exporter, the one `pi --export` uses, from the pinned SDK.
 * It is not exported from the package root, so it is imported by file;
 * test/pi-sdk/session-export.test.ts pins what the export relies on.
 */
async function htmlExporter(): Promise<ExportFromFile> {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const module = await import(
    new URL("./core/export-html/index.js", entry).href
  );
  if (typeof module.exportFromFile !== "function") {
    throw new Error("the pi SDK's HTML exporter was not found");
  }
  return module.exportFromFile;
}

function diagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message).slice(0, 500);
}

/** The redacted current branch, as pi's session JSONL. */
function serializeSession(session: ExportedSession): string {
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: text(session.getSessionId()),
    timestamp: new Date().toISOString(),
    cwd: text(session.getCwd()),
  };
  const lines: Record<string, Json>[] = [header];
  // As pi's own JSONL export does: the branch alone, each entry the child
  // of the one before it.
  let parentId: Json = null;
  for (const entry of session.getBranch()) {
    const exported = exportEntry(entry);
    exported.parentId = parentId;
    parentId = exported.id;
    lines.push(exported);
  }
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Entries

function exportEntry(entry: SessionEntry): Record<string, Json> {
  const base: Record<string, Json> = {
    type: entry.type,
    id: text(entry.id),
    parentId: null,
    timestamp: text(entry.timestamp),
  };
  switch (entry.type) {
    case "message": {
      const message = exportMessage(entry.message);
      return message
        ? { ...base, message }
        : omittedEntry(base, OMITTED_MESSAGE);
    }
    case "thinking_level_change":
      return { ...base, thinkingLevel: text(entry.thinkingLevel) };
    case "model_change":
      return {
        ...base,
        provider: text(entry.provider),
        modelId: text(entry.modelId),
      };
    case "usage":
      return {
        ...base,
        kind: text(entry.kind),
        provider: text(entry.provider),
        model: text(entry.model),
        usage: usage(entry.usage),
        note: optionalText(entry.note),
      };
    case "compaction":
      return {
        ...base,
        summary: text(entry.summary),
        firstKeptEntryId: text(entry.firstKeptEntryId),
        tokensBefore: number(entry.tokensBefore),
        details: omittedData(entry.details),
        usage: optionalUsage(entry.usage),
        fromHook: boolean(entry.fromHook),
        systemMessage:
          entry.systemMessage && exportMessage(entry.systemMessage),
      };
    case "branch_summary":
      return {
        ...base,
        fromId: text(entry.fromId),
        summary: text(entry.summary),
        details: omittedData(entry.details),
        usage: optionalUsage(entry.usage),
        fromHook: boolean(entry.fromHook),
      };
    case "custom":
      return {
        ...base,
        customType: text(entry.customType),
        data: omittedData(entry.data),
      };
    case "custom_message":
      return {
        ...base,
        customType: text(entry.customType),
        content: content(entry.content),
        display: boolean(entry.display),
        details: omittedData(entry.details),
      };
    case "context_edit":
      return {
        ...base,
        targetId: text(entry.targetId),
        replacement: entry.replacement
          ? { content: content(entry.replacement.content) }
          : null,
      };
    case "label":
      return {
        ...base,
        targetId: text(entry.targetId),
        label: optionalText(entry.label),
      };
    case "session_info":
      return { ...base, name: optionalText(entry.name) };
    default:
      return omittedEntry(base, OMITTED_ENTRY);
  }
}

/** The placeholder for an entry left out, in its place in the branch. */
function omittedEntry(
  base: Record<string, Json>,
  note: string,
): Record<string, Json> {
  return {
    ...base,
    type: "custom_message",
    customType: OMITTED_TYPE,
    content: note,
    display: true,
  };
}

// ---------------------------------------------------------------------------
// Messages

/** The message, or undefined for a kind the export does not know. */
function exportMessage(message: unknown): Record<string, Json> | undefined {
  const m = fields(message);
  const timestamp = number(m.timestamp);
  switch (m.role) {
    case "user":
      return { role: "user", content: content(m.content), timestamp };
    case "assistant":
      return {
        role: "assistant",
        content: content(m.content),
        api: text(m.api),
        provider: text(m.provider),
        model: text(m.model),
        responseModel: optionalText(m.responseModel),
        usage: usage(m.usage),
        stopReason: text(m.stopReason),
        errorMessage: optionalText(m.errorMessage),
        timestamp,
        durationMs: number(m.durationMs),
      };
    case "toolResult":
      return {
        role: "toolResult",
        toolCallId: text(m.toolCallId),
        toolName: text(m.toolName),
        content: content(m.content),
        details: toolDetails(m.toolName, m.details),
        usage: optionalUsage(m.usage),
        nestedCalls: nestedCalls(m.nestedCalls),
        isError: boolean(m.isError) ?? false,
        timestamp,
        durationMs: number(m.durationMs),
      };
    case "system":
      return {
        role: "system",
        content: content(m.content),
        sections: sections(m.sections),
        toolsAdded: Array.isArray(m.toolsAdded)
          ? m.toolsAdded.map(toolDefinition)
          : undefined,
        toolsRemoved: Array.isArray(m.toolsRemoved)
          ? m.toolsRemoved.map((tool) => ({
              name: text(isObject(tool) ? tool.name : undefined),
            }))
          : undefined,
        timestamp,
      };
    case "bashExecution":
      return {
        role: "bashExecution",
        command: text(m.command),
        output: text(m.output),
        exitCode: number(m.exitCode),
        cancelled: boolean(m.cancelled) ?? false,
        truncated: boolean(m.truncated) ?? false,
        excludeFromContext: boolean(m.excludeFromContext),
        timestamp,
      };
    case "custom":
      return {
        role: "custom",
        customType: text(m.customType),
        content: content(m.content),
        display: boolean(m.display) ?? false,
        details: omittedData(m.details),
        timestamp,
      };
    case "branchSummary":
      return {
        role: "branchSummary",
        summary: text(m.summary),
        fromId: optionalText(m.fromId) ?? null,
        timestamp,
      };
    case "compactionSummary":
      return {
        role: "compactionSummary",
        summary: text(m.summary),
        tokensBefore: number(m.tokensBefore),
        timestamp,
      };
    default:
      return undefined;
  }
}

/** Message content: a string, or blocks of text, thinking, tool calls and images. */
function content(value: unknown): Json {
  if (typeof value === "string") return text(value);
  if (!Array.isArray(value)) return [];
  return value.map(block);
}

function block(value: unknown): Json {
  const b = fields(value);
  switch (b.type) {
    case "text":
      return { type: "text", text: text(b.text) };
    case "thinking":
      return {
        type: "thinking",
        thinking: b.redacted === true ? OMITTED_THINKING : text(b.thinking),
      };
    case "toolCall":
      return {
        type: "toolCall",
        id: text(b.id),
        name: text(b.name),
        arguments: isObject(b.arguments) ? json(b.arguments) : {},
      };
    case "image":
      return { type: "text", text: omittedImage(b.mimeType) };
    default:
      return { type: "text", text: OMITTED_CONTENT };
  }
}

function omittedImage(mimeType: unknown): string {
  const type =
    typeof mimeType === "string" &&
    /^[a-z]+\/[a-z0-9.+-]{1,50}$/i.test(mimeType)
      ? ` (${mimeType})`
      : "";
  return `[image omitted from the export${type}]`;
}

/**
 * A tool's details are its own data, for its renderer. Only the edit tool's
 * diff is kept, which the HTML page shows; the rest is left out.
 */
function toolDetails(toolName: unknown, details: unknown): Json {
  if (details === undefined) return undefined;
  if (
    toolName === "edit" &&
    isObject(details) &&
    typeof details.diff === "string"
  ) {
    return { diff: text(details.diff) };
  }
  return OMITTED_DATA;
}

function nestedCalls(value: unknown): Json {
  if (!isObject(value)) return undefined;
  const calls = Array.isArray(value.calls) ? value.calls : [];
  return {
    calls: calls.map((call) => {
      const c = fields(call);
      return {
        id: text(c.id),
        name: text(c.name),
        arguments: isObject(c.arguments) ? json(c.arguments) : undefined,
        argumentsBytes: number(c.argumentsBytes),
        status: text(c.status),
        durationMs: number(c.durationMs),
        error: optionalText(c.error),
      };
    }),
    complete: boolean(value.complete) ?? false,
  };
}

function sections(value: unknown): Json {
  if (!isObject(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([name, section]) => [
      text(name),
      section === null ? null : text(section),
    ]),
  );
}

function toolDefinition(value: unknown): Json {
  const tool = fields(value);
  return {
    name: text(tool.name),
    description: text(tool.description),
    parameters: json(tool.parameters),
  };
}

function optionalUsage(value: unknown): Json {
  return value === undefined ? undefined : usage(value);
}

/** pi's Usage: token counts and their cost, numbers only. */
function usage(value: unknown): Json {
  const u = fields(value);
  const cost = fields(u.cost);
  return {
    input: number(u.input),
    output: number(u.output),
    cacheRead: number(u.cacheRead),
    cacheWrite: number(u.cacheWrite),
    cacheWrite1h: number(u.cacheWrite1h),
    reasoning: number(u.reasoning),
    totalTokens: number(u.totalTokens),
    cost: {
      input: number(cost.input),
      output: number(cost.output),
      cacheRead: number(cost.cacheRead),
      cacheWrite: number(cost.cacheWrite),
      total: number(cost.total),
    },
  };
}

// ---------------------------------------------------------------------------
// Values

function redact(value: string): string {
  return redactNamedSecretValues(redactSecrets(value));
}

/** A string, redacted, then cut to MAX_TEXT_LENGTH. Not a string: empty. */
function text(value: unknown): string {
  if (typeof value !== "string") return "";
  const redacted = redact(value);
  if (redacted.length <= MAX_TEXT_LENGTH) return redacted;
  const omitted = redacted.length - MAX_TEXT_LENGTH;
  return `${redacted.slice(0, MAX_TEXT_LENGTH)}\n[${omitted} characters omitted from the export]`;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? text(value) : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Extension data is left out; only whether there was any is kept. */
function omittedData(value: unknown): Json {
  return value === undefined ? undefined : OMITTED_DATA;
}

/** Arbitrary JSON (tool arguments, schemas), every string and key redacted. */
function json(value: unknown, depth = 0): Json {
  if (typeof value === "string") return text(value);
  if (typeof value === "number") return number(value) ?? null;
  if (typeof value === "boolean" || value === null) return value;
  if (depth >= MAX_DEPTH) return OMITTED_NESTING;
  if (Array.isArray(value)) return value.map((item) => json(item, depth + 1));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        text(key),
        json(item, depth + 1),
      ]),
    );
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object's fields to pick from; none for anything else. */
function fields(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}
