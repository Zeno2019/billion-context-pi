import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "typebox/value";
import type { TSchema } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withLeanContextTools, createLeanAcpExtension, LEAN_CONTEXT_RULES } from "../src/lean.js";
import { createRuntime } from "../src/runtime.js";
import { makeCompressTool } from "../src/compress-tool.js";
import { makeDecompressTool } from "../src/decompress-tool.js";
import { makeSearchTool } from "../src/search-tool.js";
import { makeStatusTool } from "../src/status-tool.js";
import { makeCacheTool } from "../src/cache-tool.js";
import { ACP_DELEGATE_PROMPT } from "../src/system-prompt.js";
import { buildChildArgs, setDelegateDefaults, resetDelegateDefaults } from "../src/delegate-tool.js";

type Tool = ToolDefinition<TSchema, unknown, unknown>;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function captureApi() {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, unknown>();
  const api = {
    registerTool(tool: Tool) { tools.set(tool.name, tool); },
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand(name: string, options: unknown) { commands.set(name, options); },
    registerShortcut() {},
    sendMessage() {},
    sendUserMessage() {},
  };
  return { api: api as unknown as ExtensionAPI, tools, handlers, commands };
}

function context(cwd = process.cwd()): ExtensionContext {
  return {
    mode: "print",
    hasUI: false,
    cwd,
    model: { provider: "test", id: "test-model", contextWindow: 200_000 },
    sessionManager: {
      buildContextEntries: () => [],
      getBranch: () => [],
      getSessionId: () => "lean-test-session",
      getSessionFile: () => undefined,
    },
    ui: { notify() {}, setStatus() {} },
  } as unknown as ExtensionContext;
}

function toolNamed(tools: Map<string, Tool>, name: string): Tool {
  const tool = tools.get(name);
  assert.ok(tool, `${name} must be registered`);
  return tool;
}

function text(result: AgentToolResult<unknown>): string {
  return result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
}

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description").map(([key, item]) => [key, withoutDescriptions(item)]));
  }
  return value;
}

async function fixture() {
  const runtime = createRuntime({ autoUpdate: false });
  const originals: Tool[] = [makeCompressTool(runtime), makeDecompressTool(runtime), makeSearchTool(runtime), makeStatusTool(runtime), makeCacheTool(runtime)];
  const calls: Array<{ name: string; args: Parameters<Tool["execute"]> }> = [];
  const result: AgentToolResult<unknown> = {
    content: [{ type: "text", text: "Historical source: decompress({blockId:'b1'}); search_context; acp_status; acp_cache.\n原文保持不变。" }],
    details: { original: true },
  };
  for (const tool of originals) {
    tool.execute = async (...args) => { calls.push({ name: tool.name, args }); return result; };
  }
  const captured = captureApi();
  const upstream: ExtensionFactory = async pi => {
    await Promise.resolve();
    for (const tool of originals) pi.registerTool(tool);
  };
  await withLeanContextTools(upstream)(captured.api);
  return { ...captured, originals, calls, result, facade: toolNamed(captured.tools, "acp_context") };
}

test("lean keeps compress schema constraints and callback references without mutating upstream", async () => {
  const runtime = createRuntime({ autoUpdate: false });
  const original = makeCompressTool(runtime);
  const schema = structuredClone(original.parameters);
  const description = original.description;
  const captured = captureApi();
  await withLeanContextTools(pi => { pi.registerTool(original); })(captured.api);
  const lean = toolNamed(captured.tools, "compress");
  assert.deepEqual(original.parameters, schema);
  assert.equal(original.description, description);
  assert.deepEqual(withoutDescriptions(lean.parameters), withoutDescriptions(schema));
  assert.ok(lean.description.length < description.length);
  assert.equal(lean.execute, original.execute);
  assert.equal(lean.renderCall, original.renderCall);
  assert.equal(lean.renderResult, original.renderResult);
});

test("lean awaits upstream registration and combines only four context tools", async () => {
  const { tools } = await fixture();
  assert.deepEqual([...tools.keys()].sort(), ["acp_context", "compress"]);
});

test("each context operation validates its real schema and forwards all execute arguments and result identities", async () => {
  const { facade, calls, result } = await fixture();
  const ctx = context();
  const signal = new AbortController().signal;
  const update: NonNullable<Parameters<Tool["execute"]>[3]> = () => {};
  const cases = [
    { op: "decompress", args: { blockId: "b1", full: true, inline: true } },
    { op: "search_context", args: { query: "acp_status", limit: 2 } },
    { op: "acp_status", args: { scope: "uncompressed", view: "messages", sort: "size" } },
    { op: "acp_cache", args: { detail: "full" } },
  ];
  for (const item of cases) {
    const actual = await facade.execute("call-identity", item, signal, update, ctx);
    const call = calls.at(-1);
    assert.equal(call?.name, item.op);
    assert.equal(call.args[0], "call-identity");
    assert.equal(call.args[1], item.args);
    assert.equal(call.args[2], signal);
    assert.equal(call.args[3], update);
    assert.equal(call.args[4], ctx);
    assert.equal(actual, result);
    assert.equal(actual.details, result.details);
    assert.equal(actual.content, result.content);
  }
});

test("invalid operation arguments never execute an upstream tool", async () => {
  const { facade, calls, originals } = await fixture();
  const invalid = [
    { op: "unknown", args: {} },
    { op: "decompress", args: {} },
    { op: "decompress", args: { blockId: 3 } },
    { op: "search_context", args: { query: 12 } },
    { op: "acp_status", args: { scope: "everything" } },
    { op: "acp_cache", args: { detail: "verbose" } },
    { op: "search_context" },
    { op: "decompress", args: null },
  ];
  for (const item of invalid) {
    const original = originals.find(tool => tool.name === item.op);
    if (original) assert.equal(Check(original.parameters, item.args ?? {}), false);
    try {
      const result = await facade.execute("invalid", item, undefined, undefined, context());
      assert.ok(text(result).length > 0, "rejection must explain the invalid request");
    } catch (error) {
      assert.ok(error instanceof Error);
    }
    assert.equal(calls.length, 0, JSON.stringify(item));
  }
});

test("status and cache accept omitted optional argument objects", async () => {
  const { facade, calls } = await fixture();
  for (const op of ["acp_status", "acp_cache"]) {
    await facade.execute("defaults", { op }, undefined, undefined, context());
    assert.deepEqual(calls.at(-1)?.args[1], {});
    assert.equal(calls.at(-1)?.name, op);
  }
});

test("help exposes the original operation schemas without executing them", async () => {
  const { facade, originals, calls } = await fixture();
  for (const tool of originals.filter(tool => tool.name !== "compress")) {
    const result = await facade.execute("help", { op: "help", args: { tool: tool.name } }, undefined, undefined, context());
    assert.ok(text(result).includes(JSON.stringify(tool.parameters, null, 2)), `help must expose ${tool.name}'s exact schema`);
  }
  assert.equal(calls.length, 0);
});

test("recall preserves old tool names and original source text byte for byte", async () => {
  const { facade, result } = await fixture();
  const restored = await facade.execute("recall", { op: "decompress", args: { blockId: "b1" } }, undefined, undefined, context());
  assert.equal(text(restored), text(result));
});

test("delegate tools, commands, and event callbacks pass through unchanged", async () => {
  const captured = captureApi();
  const runtime = createRuntime({ autoUpdate: false });
  const delegate = { ...makeCacheTool(runtime), name: "acp_delegate_agents" } as unknown as Tool;
  const handler = () => ({ systemPrompt: "upstream" });
  const command = { handler: async () => {} };
  await withLeanContextTools(pi => {
    pi.registerTool(delegate);
    pi.on("before_agent_start", handler);
    pi.registerCommand("example", command);
  })(captured.api);
  assert.equal(captured.tools.get(delegate.name), delegate);
  assert.equal(captured.handlers.get("before_agent_start")?.[0], handler);
  assert.equal(captured.commands.get("example"), command);
  assert.equal(captured.tools.has("acp_context"), false);
});

test("disabled and proxy upstream factories register no facade", async () => {
  const disabled = captureApi();
  await createLeanAcpExtension({ enabled: false })(disabled.api);
  assert.equal(disabled.tools.size, 0);
  const saved = process.env.BILLION_CONTEXT_PROXY;
  try {
    process.env.BILLION_CONTEXT_PROXY = "1";
    const proxy = captureApi();
    await createLeanAcpExtension()(proxy.api);
    assert.equal(proxy.tools.size, 0);
  } finally {
    if (saved === undefined) delete process.env.BILLION_CONTEXT_PROXY;
    else process.env.BILLION_CONTEXT_PROXY = saved;
  }
});

test("real lean prompt is short and keeps delegate safety notices and custom prompt overrides", async () => {
  for (const delegatePrompt of [undefined, "CUSTOM DELEGATE SAFETY"]) {
    const captured = captureApi();
    await createLeanAcpExtension({ autoUpdate: false, delegatePrompt })(captured.api);
    const handlers = captured.handlers.get("before_agent_start") ?? [];
    assert.ok(handlers.length > 0);
    const results = await Promise.all(handlers.map(handler => handler({ systemPrompt: "BASE" }, context())));
    const prompt = results.find((value): value is { systemPrompt: string } => typeof value === "object" && value !== null && "systemPrompt" in value);
    assert.ok(prompt);
    assert.ok(prompt.systemPrompt.includes(LEAN_CONTEXT_RULES));
    assert.ok(prompt.systemPrompt.includes(delegatePrompt ?? ACP_DELEGATE_PROMPT));
    assert.ok(prompt.systemPrompt.startsWith("BASE"));
    assert.ok(prompt.systemPrompt.length < (delegatePrompt ?? ACP_DELEGATE_PROMPT).length + LEAN_CONTEXT_RULES.length + 150);
    assert.ok(!prompt.systemPrompt.includes("WHEN TO COMPRESS"));
  }
});

test("real session_start registers configured agents and supports custom-agent dryRun without a model call", async () => {
  const root = await mkdtemp(join(tmpdir(), "bcp-lean-"));
  try {
    const agents = join(root, "agents");
    await mkdir(agents);
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi", "acp.json"), JSON.stringify({ autoUpdate: false, agentDir: agents, delegate: { forceEnable: true } }));
    await writeFile(join(agents, "custom-lean.md"), "---\nmodel: test/test-model\ntools: read\n---\nInspect without changing files.\n");
    const captured = captureApi();
    await createLeanAcpExtension({ autoUpdate: false, agentDir: agents, delegate: { forceEnable: true } })(captured.api);
    const ctx = context(root);
    for (const handler of captured.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
    const listing = await toolNamed(captured.tools, "acp_delegate_agents").execute("list", {}, undefined, undefined, ctx);
    assert.ok(text(listing).includes("custom-lean"));
    const plan = await toolNamed(captured.tools, "acp_delegate").execute("plan", { agent: "custom-lean", task: "Inspect", dryRun: true }, undefined, undefined, ctx);
    assert.ok(text(plan).includes("configured (from agentDir)"), text(plan));
    assert.ok(text(plan).includes("test/test-model"), text(plan));
    assert.ok(text(plan).includes("acp_context"), text(plan));
    assert.ok(!text(plan).includes("Inspect without changing files."));
    for (const handler of captured.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
  } finally {
    resetDelegateDefaults();
    await rm(root, { recursive: true, force: true });
  }
});

test("restricted delegate argv uses the lean tool names even when configured agents list legacy ACP tools", async () => {
  setDelegateDefaults({ contextTools: ["compress", "acp_context"] });
  try {
    for (const resolved of [undefined, {
      name: "custom",
      source: "configured" as const,
      prompt: "Read only.",
      tools: ["read", "compress", "decompress", "search_context", "acp_status", "acp_cache"],
    }]) {
      const built = await buildChildArgs({ agent: resolved?.name ?? "reviewer", task: "Inspect" }, "Read only.", context(), "lean-argv", resolved);
      try {
        const index = built.cliArgs.indexOf("--tools");
        assert.ok(index >= 0);
        const tools = built.cliArgs[index + 1]?.split(",") ?? [];
        assert.ok(tools.includes("read"));
        assert.ok(tools.includes("compress"));
        assert.ok(tools.includes("acp_context"));
        for (const legacy of ["decompress", "search_context", "acp_status", "acp_cache"]) assert.ok(!tools.includes(legacy));
        assert.equal(tools.length, new Set(tools).size);
      } finally {
        await rm(built.tmpDir, { recursive: true, force: true });
      }
    }
  } finally {
    resetDelegateDefaults();
  }
});
