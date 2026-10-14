// Issue #25: what the session export relies on in the pinned pi SDK's HTML
// exporter, which src/runner/session-export.ts imports by file because the
// package root does not export it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const packageEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const exporterUrl = new URL("./core/export-html/index.js", packageEntry);

describe("pi's HTML exporter", () => {
  test("is exportFromFile(inputPath, { outputPath, themeName }), and only reads that file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-html-export-"));
    try {
      const { exportFromFile } = await import(exporterUrl.href);
      const jsonl = join(dir, "s.jsonl");
      const header = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "session-1",
        timestamp: new Date(0).toISOString(),
        cwd: "/work",
      };
      const entry = {
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { role: "user", content: "hello", timestamp: 0 },
      };
      await Bun.write(
        jsonl,
        `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`,
      );

      const out = join(dir, "s.html");
      expect(
        await exportFromFile(jsonl, { outputPath: out, themeName: "dark" }),
      ).toBe(out);

      const html = readFileSync(out, "utf-8");
      const data = html.match(
        /<script id="session-data" type="application\/json">([^<]*)<\/script>/,
      )![1]!;
      // The page embeds exactly what SessionManager.open() reads from the
      // file, base64-encoded, with no system prompt, tools or pre-rendered
      // custom tool HTML.
      const embedded = JSON.parse(Buffer.from(data, "base64").toString());
      const reopened = SessionManager.open(jsonl);
      expect(embedded).toEqual({
        header: reopened.getHeader(),
        entries: reopened.getEntries(),
        leafId: reopened.getLeafId(),
      });
      // The file it read is left as it was.
      expect(readFileSync(jsonl, "utf-8")).toBe(
        `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("renders HTML in messages as text, and drops links with unsafe schemes", () => {
    const template = readFileSync(
      new URL("./core/export-html/template.js", packageEntry),
      "utf-8",
    );
    // marked's html and tag tokenizers are turned off, so markup in a
    // message is shown verbatim instead of parsed.
    expect(template).toMatch(
      /tokenizer: \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*html\(\) \{\s*return undefined;\s*\},\s*tag\(\) \{\s*return undefined;/,
    );
    // Link and image URLs pass a scheme allow-list (no javascript:, data:).
    expect(template).toContain(
      "if (scheme && !/^(https?|mailto|tel|ftp)$/i.test(scheme[1])) {",
    );
    // Code is highlighted by hljs, which escapes it, or escaped directly.
    expect(template).toContain("highlighted = escapeHtml(code);");
  });
});
