import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TSchema } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createLeanAcpExtension } from "../src/lean.js";
import { LEAN_DELEGATE_RULES } from "../src/lean-delegate.js";
import { loadAgentDef } from "../src/delegate-agents.js";
import { buildChildArgs, makeDelegateTool, resetDelegateDefaults, setDelegateDefaults } from "../src/delegate-tool.js";

type Tool = ToolDefinition<TSchema, unknown, unknown>;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type RunArgs = Parameters<ReturnType<typeof makeDelegateTool>["execute"]>[1];
const DEFAULT_MODEL = "primary/vendor/model-default";
const ALTERNATIVES = ["alternate/vendor/model-one", "backup/model-two"];
const DESCRIPTION = "Review focused changes without editing files.";
const AGENT_BODY = "Private system instructions must not appear in discovery.";

function text(result: AgentToolResult<unknown>): string {
  return result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function withFixture(run: (fixture: Awaited<ReturnType<typeof boot>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "bcp-lean-routing-"));
  let fixture: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    fixture = await boot(root);
    await run(fixture);
  } finally {
    if (fixture) for (const handler of fixture.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, fixture.ctx);
    resetDelegateDefaults();
    await rm(root, { recursive: true, force: true });
  }
}

async function boot(root: string) {
  const agents = join(root, "agents");
  await mkdir(agents);
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, ".pi", "acp.json"), JSON.stringify({ enabled: true, autoUpdate: false, agentDir: agents, delegate: { forceEnable: true } }));
  await writeFile(join(agents, "route-reviewer.md"), `---\ndescription: Review   focused\tchanges without editing files.\nmodel: ${DEFAULT_MODEL}\nthinking: high\ntools: read\nallowed-models: ${ALTERNATIVES[0]}, ${ALTERNATIVES[1]}, ${ALTERNATIVES[0]}\n---\n${AGENT_BODY}\n`);
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler[]>();
  const api = {
    registerTool(tool: Tool) { tools.set(tool.name, tool); },
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand() {},
    registerShortcut() {},
    sendMessage() {},
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    mode: "print",
    hasUI: false,
    model: { provider: "parent", id: "parent-model", contextWindow: 200_000 },
    modelRegistry: { find: (provider: string, id: string) => provider === "role" && id === "role-model" ? { provider, id } : undefined },
    sessionManager: {
      buildContextEntries: () => [],
      getBranch: () => [],
      getSessionId: () => "lean-routing-test",
      getSessionFile: () => undefined,
    },
    ui: { notify() {}, setStatus() {} },
  } as unknown as ExtensionContext;
  await createLeanAcpExtension({ autoUpdate: false, agentDir: agents, delegate: { forceEnable: true } })(api);
  for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
  const delegate = tools.get("acp_delegate");
  assert.ok(delegate);
  const loaded = await loadAgentDef("route-reviewer", agents);
  assert.ok(loaded.ok);
  return { root, agents, api, ctx, tools, handlers, delegate, def: loaded.def, original: makeDelegateTool(api, agents) };
}

async function equivalentDryRun(fixture: Awaited<ReturnType<typeof boot>>, payload: RunArgs) {
  const { agent, task, async: isAsync, ...advanced } = payload;
  const original = await fixture.original.execute("routing", payload, undefined, undefined, fixture.ctx);
  const lean = await fixture.delegate.execute("routing", { agent, ...(task === undefined ? {} : { task }), ...(isAsync === undefined ? {} : { async: isAsync }), args: advanced }, undefined, undefined, fixture.ctx);
  assert.deepEqual(lean, original);
  return text(lean);
}

async function cliFlags(
  fixture: Awaited<ReturnType<typeof boot>>,
  payload: Parameters<typeof buildChildArgs>[0],
  resolved?: Parameters<typeof buildChildArgs>[4],
) {
  const built = await buildChildArgs(payload, "Private prompt.", fixture.ctx, "lean-routing-argv", resolved);
  try {
    return { provider: flag(built.cliArgs, "--provider"), model: flag(built.cliArgs, "--model"), thinking: flag(built.cliArgs, "--thinking") };
  } finally {
    await rm(built.tmpDir, { recursive: true, force: true });
  }
}

test("agent descriptions normalize whitespace and are bounded without changing ordered allowed models", async () => {
  await withFixture(async fixture => {
    assert.equal(fixture.def.description, DESCRIPTION);
    assert.deepEqual(fixture.def.allowedModels, ALTERNATIVES);
    await writeFile(join(fixture.agents, "long-description.md"), `---\ndescription: ${"word  ".repeat(100)}\n---\nPrivate instructions.\n`);
    const long = await loadAgentDef("long-description", fixture.agents);
    assert.ok(long.ok);
    assert.equal(long.def.description, "word ".repeat(100).trim().slice(0, 240));
  });
});

test("agents discovery shows descriptions, default model, allowed choices, thinking, and built-in responsibilities", async () => {
  await withFixture(async fixture => {
    const listing = text(await fixture.delegate.execute("discover", { op: "agents" }, undefined, undefined, fixture.ctx));
    const configured = listing.split("\n").find(line => line.includes("route-reviewer"));
    assert.ok(configured);
    for (const expected of [DESCRIPTION, DEFAULT_MODEL, ...ALTERNATIVES, "high"]) assert.ok(configured.includes(expected), configured);
    assert.ok(configured.indexOf(ALTERNATIVES[0]!) < configured.indexOf(ALTERNATIVES[1]!));
    assert.ok(!listing.includes(AGENT_BODY));
    assert.ok(!listing.includes(fixture.agents));
    const reviewer = listing.split("\n").find(line => line.includes("reviewer [built-in]"));
    assert.ok(reviewer);
    assert.match(reviewer, /description:.*review/i);
    assert.match(LEAN_DELEGATE_RULES, /(?:unfamiliar|first|discover).*agents|agents.*(?:unfamiliar|first|discover)/i);
  });
});

test("the explicit agent default remains valid outside its alternative allowlist and matches the original dryRun", async () => {
  await withFixture(async fixture => {
    assert.ok(!fixture.def.allowedModels?.includes(DEFAULT_MODEL));
    const plan = await equivalentDryRun(fixture, { agent: fixture.def.name, task: "Inspect", dryRun: true });
    assert.ok(plan.includes(`- model: ${DEFAULT_MODEL} (agent file)`), plan);
    assert.ok(plan.includes("- thinking: high"), plan);
    const explicit = await equivalentDryRun(fixture, { agent: fixture.def.name, task: "Inspect", model: DEFAULT_MODEL, dryRun: true });
    assert.ok(explicit.includes(`- model: ${DEFAULT_MODEL} (per-call override)`), explicit);
    const flags = await cliFlags(fixture, { agent: fixture.def.name, task: "Inspect" }, { ...fixture.def, source: "configured" });
    assert.deepEqual(flags, { provider: "primary", model: "vendor/model-default", thinking: "high" });
  });
});

test("every allowed alternative is explicitly selectable and model identifiers retain additional slashes", async () => {
  await withFixture(async fixture => {
    for (const model of ALTERNATIVES) {
      const plan = await equivalentDryRun(fixture, { agent: fixture.def.name, task: "Inspect", model, dryRun: true });
      assert.ok(plan.includes(`- model: ${model} (per-call override)`), plan);
      const flags = await cliFlags(fixture, { agent: fixture.def.name, task: "Inspect", model }, { ...fixture.def, source: "configured" });
      const [provider, ...id] = model.split("/");
      assert.deepEqual(flags, { provider, model: id.join("/"), thinking: "high" });
    }
  });
});

test("an out-of-list model fails identically to the original tool without choosing a fallback", async () => {
  await withFixture(async fixture => {
    const plan = await equivalentDryRun(fixture, { agent: fixture.def.name, task: "Inspect", model: "outside/rejected", dryRun: true });
    assert.ok(plan.includes("not in the allowed set"), plan);
    assert.ok(!plan.includes("- source:"), plan);
    assert.ok(!plan.includes("- model:"), plan);
  });
});

test("per-call thinking overrides the agent file in both the original and lean plans and actual CLI flags", async () => {
  await withFixture(async fixture => {
    const plan = await equivalentDryRun(fixture, { agent: fixture.def.name, task: "Inspect", thinkingLevel: "low", dryRun: true });
    assert.ok(plan.includes("- thinking: low"), plan);
    const flags = await cliFlags(fixture, { agent: fixture.def.name, task: "Inspect", thinkingLevel: "low" }, { ...fixture.def, source: "configured" });
    assert.deepEqual(flags, { provider: "primary", model: "vendor/model-default", thinking: "low" });
  });
});

test("built-in role defaults beat parent model and global thinking while explicit per-call values beat role defaults", async () => {
  await withFixture(async fixture => {
    setDelegateDefaults({ thinkingLevel: "minimal", agents: { reviewer: { model: "role/role-model", thinkingLevel: "medium" } } });
    assert.deepEqual(await cliFlags(fixture, { agent: "reviewer", task: "Inspect" }), { provider: "role", model: "role-model", thinking: "medium" });
    assert.deepEqual(await cliFlags(fixture, { agent: "reviewer", task: "Inspect", model: "call/vendor/model", thinkingLevel: "xhigh" }), { provider: "call", model: "vendor/model", thinking: "xhigh" });
    const plan = await equivalentDryRun(fixture, { agent: "reviewer", task: "Inspect", dryRun: true });
    assert.ok(plan.includes("- model: role/role-model (role config)"), plan);
    assert.ok(plan.includes("- thinking: medium"), plan);
    setDelegateDefaults({ thinkingLevel: "minimal", agents: { [fixture.def.name]: { model: "role/role-model", thinkingLevel: "medium" } } });
    assert.deepEqual(await cliFlags(fixture, { agent: fixture.def.name, task: "Inspect" }, { ...fixture.def, source: "configured" }), { provider: "primary", model: "vendor/model-default", thinking: "high" });
  });
});

test("missing role settings inherit the parent model and global thinking, and absent global thinking leaves Pi's default", async () => {
  await withFixture(async fixture => {
    setDelegateDefaults({ thinkingLevel: "minimal" });
    assert.deepEqual(await cliFlags(fixture, { agent: "worker", task: "Inspect" }), { provider: "parent", model: "parent-model", thinking: "minimal" });
    const plan = await equivalentDryRun(fixture, { agent: "worker", task: "Inspect", dryRun: true });
    assert.ok(plan.includes("- model: parent/parent-model (inherited from parent)"), plan);
    resetDelegateDefaults();
    assert.deepEqual(await cliFlags(fixture, { agent: "worker", task: "Inspect" }), { provider: "parent", model: "parent-model", thinking: undefined });
    setDelegateDefaults({ agents: { reviewer: { model: "unknown/unregistered", thinkingLevel: "high" } } });
    assert.deepEqual(await cliFlags(fixture, { agent: "reviewer", task: "Inspect" }), { provider: "parent", model: "parent-model", thinking: "high" });
  });
});
