import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDeepSeekToolCalls } from "../../../open-sse/translator/deepseekWebTools.ts";

const browserTools = [
  {
    type: "function",
    function: {
      name: "browser",
      description: "Browser automation",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string" },
          kind: { type: "string" },
          text: { type: "string" },
          submit: { type: "boolean" },
          targetId: { type: "string" },
        },
      },
    },
  },
];

const execTools = [
  {
    type: "function",
    function: {
      name: "exec",
      description: "Execute a command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
];

function argsOf(result: ReturnType<typeof parseDeepSeekToolCalls>, index = 0) {
  assert.ok(result.toolCalls);
  return JSON.parse(result.toolCalls[index].function.arguments) as Record<string, unknown>;
}

describe("deepseekWebTools WMAdapter DSML regressions", () => {
  it("parses OpenClaw-style ASCII DSML invoke/parameter output", () => {
    const raw = `<|DSML| calls>\n` +
      `<|DSML| invoke name="browser">\n` +
      `<|DSML| parameter name="action" string="true">act</|DSML| parameter>\n` +
      `<|DSML| parameter name="kind" string="true">type</|DSML| parameter>\n` +
      `<|DSML| parameter name="text" string="true">omniroute</|DSML| parameter>\n` +
      `<|DSML| parameter name="submit" string="true">false</|DSML| parameter>\n` +
      `<|DSML| parameter name="targetId" string="true">15D174EAE4A6FC7B40642A5789507C17</|DSML| parameter>\n` +
      `</|DSML| invoke>\n` +
      `</|DSML| calls>`;

    const result = parseDeepSeekToolCalls(raw, "openclaw", browserTools);
    assert.equal(result.toolCalls?.length, 1);
    assert.equal(result.toolCalls?.[0].function.name, "browser");
    assert.deepEqual(argsOf(result), {
      action: "act",
      kind: "type",
      text: "omniroute",
      submit: "false",
      targetId: "15D174EAE4A6FC7B40642A5789507C17",
    });
    assert.equal(result.content.trim(), "");
  });

  it("parses WMAdapter full-width DSML shape", () => {
    const raw = `before <｜｜DSML｜｜ invoke name="exec">` +
      `<｜｜DSML｜｜ parameter name="command">pwd</｜｜DSML｜｜ parameter>` +
      `</｜｜DSML｜｜ invoke> after`;

    const result = parseDeepSeekToolCalls(raw, "wm", execTools);
    assert.equal(result.toolCalls?.length, 1);
    assert.equal(result.toolCalls?.[0].function.name, "exec");
    assert.deepEqual(argsOf(result), { command: "pwd" });
    assert.equal(result.content.replace(/\s+/g, " ").trim(), "before after");
  });

  it("does not execute an unknown DSML tool", () => {
    const raw = `<|DSML| invoke name="unknown">` +
      `<|DSML| parameter name="command">pwd</|DSML| parameter>` +
      `</|DSML| invoke>`;

    const result = parseDeepSeekToolCalls(raw, "unknown", execTools);
    assert.equal(result.toolCalls, null);
    assert.equal(result.content, raw);
  });

  it("preserves incomplete DSML instead of executing it", () => {
    const raw = `<|DSML| invoke name="exec"><|DSML| parameter name="command">`;
    const result = parseDeepSeekToolCalls(raw, "broken", execTools);
    assert.equal(result.toolCalls, null);
    assert.equal(result.content, raw);
  });

  it("does not promote ordinary JSON-like text into a DSML tool call", () => {
    const raw = `The example is {"name":"exec","arguments":{"command":"ls"}}.`;
    const result = parseDeepSeekToolCalls(raw, "json", execTools);
    assert.equal(result.toolCalls, null);
    assert.equal(result.content, raw);
  });
});
