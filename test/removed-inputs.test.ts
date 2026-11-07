// Claude-only inputs removed in issue #14: a workflow that still sets one
// fails with a pointer to the migration table instead of being ignored.
import { describe, expect, test } from "bun:test";
import {
  MIGRATION_TABLE_URL,
  assertNoRemovedInputs,
} from "../src/entrypoints/removed-inputs";

const inputs = (values: Record<string, string>) => JSON.stringify(values);

describe("assertNoRemovedInputs", () => {
  test("fails on a removed input, naming it and the migration table", () => {
    expect(() =>
      assertNoRemovedInputs(
        inputs({ model: "opencode/gpt-6-luna", claude_args: "--max-turns 5" }),
      ),
    ).toThrow(/claude_args[\s\S]*pi_args/);
    expect(() =>
      assertNoRemovedInputs(inputs({ claude_args: "--max-turns 5" })),
    ).toThrow(MIGRATION_TABLE_URL);
  });

  test("lists every removed input that is set", () => {
    expect(() =>
      assertNoRemovedInputs(
        inputs({ anthropic_api_key: "sk-ant-x", plugins: "example" }),
      ),
    ).toThrow(/anthropic_api_key[\s\S]*plugins/);
  });

  test("fails on include_fix_links, whose links opened Claude Code", () => {
    expect(() =>
      assertNoRemovedInputs(inputs({ include_fix_links: "true" })),
    ).toThrow(/include_fix_links/);
  });

  test("counts a flag set to 'false' as used, so the line gets removed", () => {
    expect(() =>
      assertNoRemovedInputs(inputs({ use_bedrock: "false" })),
    ).toThrow(/use_bedrock/);
  });

  test("passes when removed inputs are unset, which toJson gives as empty strings", () => {
    expect(() =>
      assertNoRemovedInputs(
        inputs({
          model: "opencode/gpt-6-luna",
          pi_args: "--thinking high",
          claude_args: "",
          use_bedrock: "",
          path_to_claude_code_executable: "",
        }),
      ),
    ).not.toThrow();
  });

  test("accepts settings as an active native pi input", () => {
    expect(() =>
      assertNoRemovedInputs(inputs({ settings: "{}" })),
    ).not.toThrow();
  });

  test("passes when ALL_INPUTS is missing or not JSON", () => {
    expect(() => assertNoRemovedInputs(undefined)).not.toThrow();
    expect(() => assertNoRemovedInputs("not json")).not.toThrow();
  });
});
