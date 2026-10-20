import { test } from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import type { TSchema } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withLeanDelegateTools } from "../src/lean-delegate.js";
import { makeDelegateTool, makeDelegateWaitTool, makeDelegateCancelTool, makeDelegateAgentsTool } from "../src/delegate-tool.js";

type Tool = ToolDefinition<TSchema, unknown, unknown>;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
const ctx = { cwd: process.cwd(), mode: "print" } as unknown as ExtensionContext;

function captureApi() {
  const registrations: Tool[] = [];
  const handlers = new Map<string, Handler[]>();
  const api = {
    registerTool(tool: Tool) { registrations.push(tool); },
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  return { api, registrations, handlers };
}

function text(result: AgentToolResult<unknown>): string {
  return result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
}

async function fixture() {
  const captured = captureApi();
  const originals: Tool[] = [makeDelegateTool(captured.api), makeDelegateWaitTool(captured.api), makeDelegateCancelTool(captured.api), makeDelegateAgentsTool()];
  const calls: Array<{ name: string; args: Parameters<Tool["execute"]> }> = [];
  const result: AgentToolResult<unknown> = {
    content: [{ type: "text", text: "acp_delegate_wait({runId:'old'}); acp_delegate_cancel; acp_delegate_agents\n原始委派结果。" }],
    details: { original: true, runId: "run-identity" },
  };
  for (const tool of originals) {
    tool.execute = async (...args) => {
      calls.push({ name: tool.name, args });
      args[3]?.(result);
      return result;
    };
  }
  await withLeanDelegateTools(async pi => {
    await Promise.resolve();
    for (const tool of originals) pi.registerTool(tool);
  })(captured.api);
  const facade = captured.registrations.find(tool => tool.name === "acp_delegate");
  assert.ok(facade);
  return { ...captured, originals, calls, result, facade };
}

test("delegate facade awaits upstream and replaces four tools with a single short entry", async () => {
  const { registrations, originals, facade } = await fixture();
  assert.deepEqual(registrations.map(tool => tool.name), ["acp_delegate"]);
  assert.ok(facade.description.length < originals[0]!.description.length);
  assert.deepEqual(facade.promptGuidelines ?? [], []);
});

test("run is the default operation and forwards common top-level fields", async () => {
  const { facade, calls, result } = await fixture();
  for (const op of [undefined, "run"]) {
    const params = { ...(op ? { op } : {}), agent: "reviewer", task: "Inspect", async: false };
    assert.equal(await facade.execute("run", params, undefined, undefined, ctx), result);
    assert.equal(calls.at(-1)?.name, "acp_delegate");
    assert.deepEqual(calls.at(-1)?.args[1], { agent: "reviewer", task: "Inspect", async: false });
  }
});

test("advanced run arguments and recovery remain reachable through args", async () => {
  const { facade, calls, originals } = await fixture();
  const args = { cwd: "/tmp", model: "test/model", thinkingLevel: "high", showThinking: true, timeoutMinutes: 30, dryRun: true };
  const expected = { agent: "custom", task: "Inspect", async: true, ...args };
  assert.equal(Check(originals[0]!.parameters, expected), true);
  await facade.execute("advanced", { agent: "custom", task: "Inspect", async: true, args }, undefined, undefined, ctx);
  assert.deepEqual(calls.at(-1)?.args[1], expected);
  await facade.execute("resume", { agent: "custom", args: { resumeFrom: "previous-run", dryRun: true } }, undefined, undefined, ctx);
  assert.deepEqual(calls.at(-1)?.args[1], { agent: "custom", resumeFrom: "previous-run", dryRun: true });
});

test("wait, cancel, and agents preserve execution and update arguments and original results", async () => {
  const { facade, calls, result } = await fixture();
  const signal = new AbortController().signal;
  const updates: AgentToolResult<unknown>[] = [];
  const onUpdate: NonNullable<Parameters<Tool["execute"]>[3]> = update => { updates.push(update); };
  for (const item of [
    { params: { op: "wait", runId: "run-identity", args: { timeout: 2000 } }, name: "acp_delegate_wait", expected: { runId: "run-identity", timeout: 2000 } },
    { params: { op: "cancel", runId: "run-identity" }, name: "acp_delegate_cancel", expected: { runId: "run-identity" } },
    { params: { op: "agents" }, name: "acp_delegate_agents", expected: {} },
  ]) {
    const actual = await facade.execute("call-identity", item.params, signal, onUpdate, ctx);
    const call = calls.at(-1);
    assert.equal(call?.name, item.name);
    assert.equal(call.args[0], "call-identity");
    assert.deepEqual(call.args[1], item.expected);
    assert.equal(call.args[2], signal);
    assert.equal(call.args[3], onUpdate);
    assert.equal(call.args[4], ctx);
    assert.equal(actual, result);
    assert.equal(actual.content, result.content);
    assert.equal(actual.details, result.details);
    assert.equal(updates.at(-1), result);
    assert.equal(text(actual), text(result));
  }
});

test("help defaults to run and exposes every original operation description and schema", async () => {
  const { facade, originals, calls } = await fixture();
  for (const [index, op] of ["run", "wait", "cancel", "agents"].entries()) {
    const original = originals[index]!;
    const params = op === "run" ? { op: "help" } : { op: "help", args: { op } };
    const result = await facade.execute("help", params, undefined, undefined, ctx);
    assert.ok(text(result).includes(original.description), op);
    assert.ok(text(result).includes(JSON.stringify(original.parameters, null, 2)), op);
  }
  assert.equal(calls.length, 0);
});

test("unknown operations, undeclared parameters, missing required fields, and incorrect types never execute", async () => {
  const { facade, calls } = await fixture();
  for (const params of [
    { op: "unknown" },
    { task: "missing agent" },
    { agent: 123, task: "wrong type" },
    { agent: "reviewer", task: "Inspect", dryRun: true },
    { agent: "reviewer", task: "Inspect", args: { unknownOption: true } },
    { agent: "reviewer", task: "Inspect", args: { dryRun: "yes" } },
    { agent: "reviewer", task: "Inspect", args: null },
    { op: "wait" },
    { op: "wait", runId: 123 },
    { op: "wait", runId: "r", args: { timeout: "2000" } },
    { op: "wait", runId: "r", args: { timeout: 1.5 } },
    { op: "wait", runId: "r", agent: "reviewer" },
    { op: "cancel", runId: "r", args: { timeout: 2000 } },
    { op: "agents", args: { query: "reviewer" } },
    { op: "help", args: { op: "unknown" } },
  ]) {
    await assert.rejects(() => facade.execute("invalid", params, undefined, undefined, ctx), JSON.stringify(params));
    assert.equal(calls.length, 0);
  }
});

test("duplicate top-level and advanced argument names are rejected even when values match", async () => {
  const { facade, calls } = await fixture();
  for (const params of [
    { agent: "reviewer", task: "Inspect", args: { agent: "reviewer" } },
    { agent: "reviewer", task: "Inspect", args: { task: "different task" } },
    { agent: "reviewer", task: "Inspect", async: false, args: { async: false } },
    { op: "wait", runId: "run", args: { runId: "other-run" } },
  ]) {
    await assert.rejects(() => facade.execute("conflict", params, undefined, undefined, ctx));
  }
  assert.equal(calls.length, 0);
});

test("session-start registrations create one facade and refresh the captured tools on later sessions", async () => {
  const captured = captureApi();
  let generation = 0;
  const calls: number[] = [];
  await withLeanDelegateTools(pi => {
    pi.on("session_start", () => {
      const current = ++generation;
      const tools: Tool[] = [makeDelegateTool(pi), makeDelegateWaitTool(pi), makeDelegateCancelTool(pi), makeDelegateAgentsTool()];
      for (const tool of tools) {
        tool.execute = async () => { calls.push(current); return { content: [], details: current }; };
        pi.registerTool(tool);
      }
    });
  })(captured.api);
  assert.equal(captured.registrations.length, 0);
  const handler = captured.handlers.get("session_start")?.[0];
  assert.ok(handler);
  for (const expectedGeneration of [1, 2]) {
    await handler({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(captured.registrations.length, 1);
    const facade = captured.registrations[0]!;
    for (const params of [{ agent: "reviewer", task: "Inspect" }, { op: "wait", runId: "r" }, { op: "cancel", runId: "r" }, { op: "agents" }]) {
      const result = await facade.execute("late", params, undefined, undefined, ctx);
      assert.equal(result.details, expectedGeneration);
    }
  }
  assert.deepEqual(calls, [1, 1, 1, 1, 2, 2, 2, 2]);
});

test("disabled delegate registration exposes no facade and unrelated tools and events pass through", async () => {
  const captured = captureApi();
  const unrelated = { ...makeDelegateAgentsTool(), name: "other_tool" } as unknown as Tool;
  const handler = () => ({ systemPrompt: "unchanged" });
  await withLeanDelegateTools(pi => {
    pi.registerTool(unrelated);
    pi.on("before_agent_start", handler);
  })(captured.api);
  assert.deepEqual(captured.registrations, [unrelated]);
  assert.equal(captured.registrations[0], unrelated);
  assert.equal(captured.handlers.get("before_agent_start")?.[0], handler);
});
