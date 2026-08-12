import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  buildChildArgs,
  injectedWaitMessage,
  makeDelegateTool,
  makeDelegateWaitTool,
  makeDelegateAgentsTool,
  makeDelegateCancelTool,
  type DelegateRuntimeHooks,
} from "../src/delegate-tool.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Minimal ctx mock - buildChildArgs only reads ctx.model. */
function mockCtx(): ExtensionContext {
  return { model: { provider: "test", id: "test-model" } } as unknown as ExtensionContext;
}

/** Minimal ctx mock for the dryRun path: needs mode/cwd/model. */
function mockDryRunCtx(): ExtensionContext {
  return {
    mode: "print",
    cwd: process.cwd(),
    model: { provider: "test", id: "test-model" },
  } as unknown as ExtensionContext;
}

/** Minimal pi mock - the dryRun path never calls sendUserMessage. */
function mockPi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}

const RESTRICTED_ROLES = ["reviewer", "researcher", "planner", "oracle"] as const;
const ACP_TOOLS = ["compress", "decompress", "search_context", "acp_status"];

/** Parse the --tools value from cliArgs, or null if absent. */
function getToolsValue(cliArgs: string[]): string | null {
  const idx = cliArgs.indexOf("--tools");
  if (idx < 0) return null;
  return cliArgs[idx + 1] ?? null;
}

// ─── Restricted roles: --tools present with base tools + ACP ───────────────

for (const role of RESTRICTED_ROLES) {
  test(`buildChildArgs includes --tools with ACP append for ${role}`, async () => {
    const { cliArgs } = await buildChildArgs(
      { agent: role, task: "test task" },
      "prompt",
      mockCtx(),
    );
    const toolsStr = getToolsValue(cliArgs);
    assert.ok(toolsStr, `--tools flag present for ${role}`);
    const tools = toolsStr!.split(",");

    // Base tools present
    for (const bt of ["read", "bash", "grep", "find", "ls"]) {
      assert.ok(tools.includes(bt), `${role} tools include ${bt}`);
    }
    // ACP tools present
    for (const at of ACP_TOOLS) {
      assert.ok(tools.includes(at), `${role} tools include ACP tool ${at}`);
    }
    // No edit/write
    assert.ok(!tools.includes("edit"), `${role} tools do NOT include edit`);
    assert.ok(!tools.includes("write"), `${role} tools do NOT include write`);
    // No glob (not a Pi core tool)
    assert.ok(!tools.includes("glob"), `${role} tools do NOT include glob`);
    // No duplicates
    assert.equal(tools.length, new Set(tools).size, `${role} tools have no duplicates`);
    // Expected order: base tools first, then ACP tools
    const expected = ["read", "bash", "grep", "find", "ls", ...ACP_TOOLS];
    assert.deepEqual(tools, expected, `${role} tools in expected order`);
  });
}

// ─── Worker: no --tools, full default toolset ─────────────────────────────

test("buildChildArgs omits --tools for worker role", async () => {
  const { cliArgs } = await buildChildArgs(
    { agent: "worker", task: "fix bug" },
    "You are a worker.",
    mockCtx(),
  );
  assert.equal(getToolsValue(cliArgs), null, "worker does NOT receive --tools");
});

test("buildChildArgs worker still inherits provider/model from ctx", async () => {
  const { cliArgs } = await buildChildArgs(
    { agent: "worker", task: "fix bug" },
    "prompt",
    mockCtx(),
  );
  const providerIdx = cliArgs.indexOf("--provider");
  const modelIdx = cliArgs.indexOf("--model");
  assert.ok(providerIdx >= 0, "worker has --provider from ctx.model");
  assert.equal(cliArgs[providerIdx + 1], "test");
  assert.ok(modelIdx >= 0, "worker has --model from ctx.model");
  assert.equal(cliArgs[modelIdx + 1], "test-model");
});

// ─── Unknown agent: no --tools ─────────────────────────────────────────────

test("buildChildArgs omits --tools for unknown agent name", async () => {
  const { cliArgs } = await buildChildArgs(
    { agent: "nonexistent-role", task: "test" },
    "prompt",
    mockCtx(),
  );
  assert.equal(getToolsValue(cliArgs), null, "--tools not added for unknown agent");
});

// ─── --tools comes before --provider/--model ───────────────────────────────

test("buildChildArgs places --tools before --provider/--model", async () => {
  const { cliArgs } = await buildChildArgs(
    { agent: "reviewer", task: "test", model: "openai/gpt-5" },
    "prompt",
    mockCtx(),
  );
  const toolsIdx = cliArgs.indexOf("--tools");
  const providerIdx = cliArgs.indexOf("--provider");
  assert.ok(toolsIdx >= 0 && providerIdx >= 0);
  assert.ok(toolsIdx < providerIdx, "--tools comes before --provider");
});

// ─── ctx.model inheritance (no explicit model) ────────────────────────────

test("buildChildArgs inherits model from ctx when model not specified", async () => {
  const { cliArgs } = await buildChildArgs(
    { agent: "reviewer", task: "test" },
    "prompt",
    mockCtx(),
  );
  const providerIdx = cliArgs.indexOf("--provider");
  const modelIdx = cliArgs.indexOf("--model");
  assert.ok(providerIdx >= 0, "--provider present from ctx.model");
  assert.equal(cliArgs[providerIdx + 1], "test");
  assert.ok(modelIdx >= 0, "--model present from ctx.model");
  assert.equal(cliArgs[modelIdx + 1], "test-model");
});

// ─── explicit model override ──────────────────────────────────────────────

test("buildChildArgs uses explicit model override when provided", async () => {
  const { cliArgs } = await buildChildArgs(
    { agent: "worker", task: "test", model: "anthropic/claude-5" },
    "prompt",
    mockCtx(),
  );
  const providerIdx = cliArgs.indexOf("--provider");
  const modelIdx = cliArgs.indexOf("--model");
  assert.ok(providerIdx >= 0);
  assert.equal(cliArgs[providerIdx + 1], "anthropic");
  assert.ok(modelIdx >= 0);
  assert.equal(cliArgs[modelIdx + 1], "claude-5");
});

// ─── wait() dedup: already-injected run returns "already delivered" ───────
// Race scenario: the delegate finishes quickly, the close handler injects the
// result as a system notification, and THEN the model calls acp_delegate_wait.
// Without dedup the model sees the same result twice (notification + tool
// result). injectedWaitMessage is the pure helper that short-circuits this.

test("injectedWaitMessage returns null when run was NOT injected", () => {
  assert.equal(injectedWaitMessage({ injected: false }, "del_x", ""), null);
  assert.equal(injectedWaitMessage({}, "del_x", ""), null);
});

test("injectedWaitMessage dedup message names the runId and the result file", () => {
  const msg = injectedWaitMessage(
    { injected: true, result: { file: "/tmp/acp-delegate/del_x.out" } },
    "del_x",
    "",
  );
  assert.ok(msg, "returns a message for an injected run");
  assert.ok(msg!.includes("del_x"), "names the runId");
  assert.ok(msg!.includes("/tmp/acp-delegate/del_x.out"), "points at the result file");
  assert.ok(msg!.includes("already delivered"), "states it was already delivered");
  assert.ok(msg!.includes("no need to wait"), "tells the model not to wait again");
});

test("injectedWaitMessage surfaces remaining delegates and tolerates a missing file", () => {
  const msg = injectedWaitMessage(
    { injected: true },
    "del_x",
    " 2 delegates are still running.",
  );
  assert.ok(msg!.includes("2 delegates are still running"), "passes through the remaining line");
  assert.ok(!msg!.includes("read the result file"), "omits the file line when file is absent");
});

// ─── Configured-agent resolution precedence (dryRun chain) ─────────────────
// These tests drive the full resolution path (resolveAgent → runDelegate →
// planDryRun) through the public tool API with dryRun:true — no spawn, no
// temp dirs, no side effects. A real agentDir fixture is required so the
// resolver sees actual .md files.

const fixtureDirs: string[] = [];

async function makeAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), ".delegate-tool-test-agentdir-"));
  fixtureDirs.push(dir);
  return dir;
}

async function writeAgentMd(dir: string, fileName: string, content: string): Promise<void> {
  await writeFile(join(dir, fileName), content, "utf8");
}

/** Run a dryRun acp_delegate call and return the tool text result. */
async function dryRunPlan(
  agentDir: string | undefined,
  params: {
    agent: string;
    task: string;
    cwd?: string;
    model?: string;
    thinking?: string;
    async?: boolean;
    dryRun?: boolean;
    timeout?: number;
  },
): Promise<string> {
  const tool = makeDelegateTool(mockPi(), agentDir);
  const res = await tool.execute("dry", params, undefined, undefined, mockDryRunCtx());
  const content = res.content[0];
  const text = content && "text" in content ? content.text : "";
  return text;
}

const CONFIGURED_REVIEWER_MD = `---
name: reviewer
model: anthropic/claude-4.5
thinking: high
tools: read
allowed-models: openai/gpt-5, anthropic/claude-4.5
timeout: 30
---
Configured reviewer prompt.
`;

after(async () => {
  for (const dir of fixtureDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  // Remove result files persisted by the async timeout tests (persistResult
  // writes into tmpdir()/acp-delegate). Best-effort — the sandbox may block.
  try {
    const files = await readdir(OUT_DIR);
    for (const f of files.filter((f) => f.startsWith("del_"))) {
      await rm(join(OUT_DIR, f), { force: true });
    }
  } catch {
    // directory absent or unremovable — fine
  }
  // Remove buildChildArgs temp dirs. runDelegate's cleanupTmp is fire-and-
  // forget (may not finish before the test ends) and the direct buildChildArgs
  // tests never clean up — every acp-delegate-* dir in tmpdir() is owned
  // exclusively by this test file.
  try {
    const entries = await readdir(tmpdir());
    for (const e of entries.filter((e) => e.startsWith("acp-delegate-"))) {
      await rm(join(tmpdir(), e), { recursive: true, force: true });
    }
  } catch {
    // unreadable tmpdir — fine
  }
});

test("configured same-name agent overrides built-in (dryRun shows configured source)", async () => {
  const dir = await makeAgentDir();
  await writeAgentMd(dir, "reviewer.md", CONFIGURED_REVIEWER_MD);

  const plan = await dryRunPlan(dir, { agent: "reviewer", task: "x", dryRun: true });
  assert.ok(plan.includes("- source: configured (from agentDir)"), `configured source: ${plan}`);
  assert.ok(plan.includes("- model: anthropic/claude-4.5 (agent file)"), `md model: ${plan}`);
  assert.ok(plan.includes("- thinking: high"), `md thinking: ${plan}`);
  assert.ok(plan.includes("- timeout: 30s"), `md timeout: ${plan}`);
  assert.ok(plan.includes("read, compress, decompress, search_context, acp_status (--tools allowlist)"), `md tools + ACP: ${plan}`);
});

test("per-call model/thinking/timeout override the configured md", async () => {
  const dir = await makeAgentDir();
  await writeAgentMd(dir, "reviewer.md", CONFIGURED_REVIEWER_MD);

  const plan = await dryRunPlan(dir, {
    agent: "reviewer",
    task: "x",
    dryRun: true,
    model: "openai/gpt-5",
    thinking: "low",
    timeout: 7,
  });
  assert.ok(plan.includes("- model: openai/gpt-5 (per-call override)"), `per-call model: ${plan}`);
  assert.ok(plan.includes("- thinking: low"), `per-call thinking: ${plan}`);
  assert.ok(plan.includes("- timeout: 7s"), `per-call timeout: ${plan}`);
});

test("configured allowed-models accepts an in-list per-call model override", async () => {
  const dir = await makeAgentDir();
  await writeAgentMd(dir, "reviewer.md", CONFIGURED_REVIEWER_MD);

  const plan = await dryRunPlan(dir, {
    agent: "reviewer",
    task: "x",
    dryRun: true,
    model: "openai/gpt-5",
  });
  assert.ok(plan.includes("- model: openai/gpt-5 (per-call override)"), `in-list override accepted: ${plan}`);
});

test("configured allowed-models rejects an out-of-list override (not auto-fallback)", async () => {
  const dir = await makeAgentDir();
  await writeAgentMd(dir, "reviewer.md", CONFIGURED_REVIEWER_MD);

  const plan = await dryRunPlan(dir, {
    agent: "reviewer",
    task: "x",
    dryRun: true,
    model: "google/gemini-3",
  });
  assert.ok(plan.includes("not in the allowed set"), `rejection message: ${plan}`);
  assert.ok(!plan.includes("source:"), "must NOT silently fall back to another model/source");
});

test("malformed same-name definition fails closed without falling back to built-in", async () => {
  const dir = await makeAgentDir();
  await writeAgentMd(dir, "reviewer.md", "---\nthinking: turbo\n---\nbody\n");

  const plan = await dryRunPlan(dir, { agent: "reviewer", task: "x", dryRun: true });
  assert.ok(plan.includes("failed to load"), `fail-closed message: ${plan}`);
  assert.ok(plan.includes('invalid thinking level "turbo"'), `reason surfaced: ${plan}`);
  assert.ok(!plan.includes("- source: built-in"), "must NOT fall back to the built-in reviewer");
  assert.ok(!plan.includes("You are a senior code reviewer"), "must NOT emit the built-in prompt");
});

test("built-in fallback applies when the same-name configured file is absent", async () => {
  const dir = await makeAgentDir();
  await writeAgentMd(dir, "custom-only.md", CONFIGURED_REVIEWER_MD); // only a custom agent

  const plan = await dryRunPlan(dir, { agent: "reviewer", task: "x", dryRun: true });
  assert.ok(plan.includes("- source: built-in"), `built-in fallback: ${plan}`);
  assert.ok(plan.includes("read, bash, grep, find, ls, compress, decompress, search_context, acp_status (--tools allowlist)"), `built-in restricted tools + ACP: ${plan}`);
});

// ─── Configured agent → child args mapping (buildChildArgs with resolved) ──

test("buildChildArgs maps configured tools and dedupes the ACP append", async () => {
  const { cliArgs } = await buildChildArgs(
    { agent: "custom", task: "t" },
    "custom prompt",
    mockCtx(),
    {
      name: "custom",
      source: "configured",
      prompt: "custom prompt",
      tools: ["read", "compress", "grep"], // compress already present: must not duplicate
    },
  );
  const toolsStr = getToolsValue(cliArgs);
  assert.equal(
    toolsStr,
    "read,compress,grep,decompress,search_context,acp_status",
    "configured tools first, ACP tools appended without duplicates",
  );
});

test("buildChildArgs maps configured model and thinking", async () => {
  const { cliArgs } = await buildChildArgs(
    { agent: "custom", task: "t" },
    "custom prompt",
    mockCtx(),
    {
      name: "custom",
      source: "configured",
      prompt: "custom prompt",
      model: "anthropic/claude-4.5",
      thinking: "high",
    },
  );
  const providerIdx = cliArgs.indexOf("--provider");
  const modelIdx = cliArgs.indexOf("--model");
  assert.ok(providerIdx >= 0, "--provider present from configured model");
  assert.equal(cliArgs[providerIdx + 1], "anthropic");
  assert.ok(modelIdx >= 0, "--model present from configured model");
  assert.equal(cliArgs[modelIdx + 1], "claude-4.5");
  const thinkingIdx = cliArgs.indexOf("--thinking");
  assert.ok(thinkingIdx >= 0, "--thinking present from configured thinking");
  assert.equal(cliArgs[thinkingIdx + 1], "high");
});

test("buildChildArgs per-call model beats the configured md model", async () => {
  const { cliArgs } = await buildChildArgs(
    { agent: "custom", task: "t", model: "openai/gpt-5" },
    "custom prompt",
    mockCtx(),
    {
      name: "custom",
      source: "configured",
      prompt: "custom prompt",
      model: "anthropic/claude-4.5",
    },
  );
  const providerIdx = cliArgs.indexOf("--provider");
  const modelIdx = cliArgs.indexOf("--model");
  assert.ok(providerIdx >= 0);
  assert.equal(cliArgs[providerIdx + 1], "openai", "per-call provider wins");
  assert.ok(modelIdx >= 0);
  assert.equal(cliArgs[modelIdx + 1], "gpt-5", "per-call model wins");
});

test("buildChildArgs configured agent without tools gets no --tools (ambient)", async () => {
  const { cliArgs } = await buildChildArgs(
    { agent: "custom", task: "t" },
    "custom prompt",
    mockCtx(),
    { name: "custom", source: "configured", prompt: "custom prompt" },
  );
  assert.equal(getToolsValue(cliArgs), null, "no --tools for unrestricted configured agent");
});

// ─── dryRun: zero side effects + sanitized output ───────────────────────────
// OUT_DIR (persistResult's target) is join(tmpdir(), "acp-delegate"). A dryRun
// that spawned or persisted would show up as a new file there (or a runId /
// "Delegated to" in the result).

const OUT_DIR = join(tmpdir(), "acp-delegate");

async function outDirFiles(): Promise<string[]> {
  try {
    return (await readdir(OUT_DIR)).sort();
  } catch {
    return []; // directory may not exist yet
  }
}

test("dryRun does not spawn, register a run, or persist a result file", async () => {
  const dir = await makeAgentDir();
  await writeAgentMd(dir, "reviewer.md", CONFIGURED_REVIEWER_MD);
  const before = await outDirFiles();

  const plan = await dryRunPlan(dir, { agent: "reviewer", task: "x", dryRun: true });

  assert.ok(plan.includes("DryRun plan"), "returns a plan, not a run notification");
  assert.ok(!plan.includes("del_"), "no runId was created");
  assert.ok(!plan.includes("Delegated to"), "did not take the async delegation path");
  assert.deepEqual(await outDirFiles(), before, "no result file was persisted");
});

test("dryRun plan shows effective fields but no prompt body or task content", async () => {
  const dir = await makeAgentDir();
  await writeAgentMd(
    dir,
    "reviewer.md",
    CONFIGURED_REVIEWER_MD.replace("Configured reviewer prompt.", "CONFIDENTIAL_PROMPT_MARKER body."),
  );

  const plan = await dryRunPlan(dir, {
    agent: "reviewer",
    task: "handle SUPER_SECRET_TOKEN=abc123",
    dryRun: true,
  });

  // Effective plan fields are present.
  assert.ok(plan.includes("- source: configured (from agentDir)"), "source shown");
  assert.ok(plan.includes("- model: anthropic/claude-4.5 (agent file)"), "model shown");
  assert.ok(plan.includes("- thinking: high"), "thinking shown");
  assert.ok(plan.includes("--tools allowlist"), "tools policy shown");
  assert.ok(plan.includes("- timeout: 30s"), "timeout shown");
  assert.ok(plan.includes("- freshContext: true (pi -p --no-session)"), "fresh-context shown");

  // No body prompt, no task secret, no full argv values.
  assert.ok(!plan.includes("CONFIDENTIAL_PROMPT_MARKER"), "agent body prompt must not leak");
  assert.ok(!plan.includes("SUPER_SECRET_TOKEN"), "task secret must not leak");
  assert.ok(!plan.includes("abc123"), "secret value must not leak");
});

test("dryRun plan lists only flag names, never env, temp paths, or argv values", async () => {
  const dir = await makeAgentDir();
  await writeAgentMd(dir, "reviewer.md", CONFIGURED_REVIEWER_MD);

  const plan = await dryRunPlan(dir, { agent: "reviewer", task: "x", dryRun: true });

  // Exact flag line: names only, no values (esp. no --append-system-prompt file path).
  assert.ok(
    plan.includes("- CLI flags: -p, --no-session, --append-system-prompt, --tools, --provider, --model, --thinking"),
    `exact flag names line: ${plan}`,
  );
  assert.ok(!plan.includes("role.md"), "no temp prompt file path");
  assert.ok(!plan.includes("PATH="), "no environment variables");
  assert.ok(!plan.includes("acp-delegate-"), "no temp dir fragments");
  assert.ok(!plan.includes("process.env"), "no env access pattern");
});

// ─── acp_delegate_agents: discovery + sanitization ─────────────────────────

async function listAgents(agentDir: string | undefined): Promise<string> {
  const tool = makeDelegateAgentsTool(agentDir);
  const res = await tool.execute("list", {}, undefined, undefined, mockDryRunCtx());
  const content = res.content[0];
  return content && "text" in content ? content.text : "";
}

test("acp_delegate_agents without agentDir lists only built-ins", async () => {
  const out = await listAgents(undefined);

  for (const name of ["reviewer", "researcher", "worker", "planner", "oracle"]) {
    assert.ok(out.includes(`${name} [built-in]`), `built-in ${name} listed`);
  }
  assert.ok(!out.includes("Configured (from agentDir)"), "no configured section when agentDir absent");
  assert.ok(!out.includes("Invalid ("), "no invalid section when agentDir absent");
});

test("acp_delegate_agents with agentDir lists override, custom, and invalid entries", async () => {
  const dir = await makeAgentDir();
  await writeAgentMd(dir, "reviewer.md", CONFIGURED_REVIEWER_MD); // same-name override
  await writeAgentMd(dir, "custom-agent.md", "---\nmodel: openai/gpt-5\ntimeout: 60\n---\ncustom body\n");
  await writeAgentMd(dir, "broken.md", "---\nthinking: nope\n---\nbody\n");

  const out = await listAgents(dir);

  // Same-name configured is effective, with the built-in noted as available.
  assert.ok(out.includes("reviewer [configured]"), "configured reviewer is effective");
  assert.ok(out.includes("(built-in also available)"), "built-in availability noted");
  assert.ok(out.includes("custom-agent [configured]"), "custom agent listed");
  assert.ok(out.includes("broken [configured] INVALID: invalid thinking level \"nope\""), "invalid entry with controlled reason");

  // Built-in section lists the remaining roles but NOT the overridden one.
  assert.ok(out.includes("researcher [built-in]"), "researcher still listed");
  assert.ok(out.includes("worker [built-in]"), "worker still listed");
  assert.ok(out.includes("planner [built-in]"), "planner still listed");
  assert.ok(out.includes("oracle [built-in]"), "oracle still listed");
  assert.ok(!out.includes("reviewer [built-in]"), "overridden reviewer absent from built-in list");
});

test("acp_delegate_agents output is sanitized (no body, env, credentials, or absolute paths)", async () => {
  const dir = await makeAgentDir();
  await writeAgentMd(
    dir,
    "reviewer.md",
    `---
name: reviewer
model: anthropic/claude-4.5
api_key: sk-abc123def
allowed-models: anthropic/claude-4.5
---
LIST_SECRET_BODY=xyz
`,
  );

  const out = await listAgents(dir);

  assert.ok(!out.includes("LIST_SECRET_BODY"), "no markdown body content");
  assert.ok(!out.includes("sk-abc123def"), "no credential-like values");
  assert.ok(!out.includes("api_key"), "no unknown frontmatter keys");
  assert.ok(!out.includes(dir), "no absolute agentDir path");
  assert.ok(!out.includes("PATH="), "no environment variables");
});

test("acp_delegate_agents invalid entries expose only controlled reasons, not file contents", async () => {
  const dir = await makeAgentDir();
  await writeAgentMd(dir, "broken.md", "---\nthinking: nope\n---\nRAWDATA_LEAK=1\n");

  const out = await listAgents(dir);

  assert.ok(out.includes("broken [configured] INVALID: invalid thinking level \"nope\""), "controlled reason shown");
  assert.ok(!out.includes("RAWDATA_LEAK"), "raw file content must not leak");
});

// ─── Deterministic async timeout lifecycle (T2-S2) ──────────────────────────
// Drives the async delegate path through the @internal DelegateRuntimeHooks
// seam: a fake child (EventEmitter) + a controllable timer queue. No real
// spawn, no real timers, no child processes. Assertions observe kill() calls,
// scheduled/cleared timers, and injected notification texts.

/** Controllable timer queue standing in for setTimeout/clearTimeout. Timers
 *  carry absolute "at" offsets from t=0; advance() fast-forwards the clock and
 *  fires due timers in registration order (newly scheduled timers also fire
 *  if their deadline falls within the same advance window). */
class FakeTimers {
  private now = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;
  /** Every setTimeout call, in order: { id, at, ms }. */
  scheduled: { id: number; at: number; ms: number }[] = [];
  /** Every clearTimeout call, in order (ids). */
  clearedIds: number[] = [];

  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, fn });
    this.scheduled.push({ id, at: this.now + ms, ms });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    const id = Number(timer);
    this.clearedIds.push(id);
    this.timers.delete(id);
  }

  /** Advance the fake clock by `ms` and fire all timers whose deadline is
   *  now reached, in registration order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (due.length === 0) break;
      this.now = due[0][1].at;
      for (const [id, t] of due) {
        this.timers.delete(id);
        t.fn();
      }
    }
    if (this.now < target) this.now = target;
  }

  /** Number of timers still scheduled (not fired, not cleared). */
  pending(): number {
    return this.timers.size;
  }
}

class FakeStream extends EventEmitter {
  end(): void { /* no-op */ }
}

class FakeChild extends EventEmitter {
  killed: string[] = [];
  stdin = new FakeStream();
  stdout = new FakeStream();
  stderr = new FakeStream();
  unrefCalls = 0;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(String(signal));
    return true;
  }

  unref(): void {
    this.unrefCalls++;
  }
}

interface FakeRuntime {
  hooks: DelegateRuntimeHooks;
  timers: FakeTimers;
  child: FakeChild;
  /** Texts passed to pi.sendUserMessage by the close handler (injection). */
  injected: string[];
  /** Captured spawn invocations, in order: { command, args }. */
  spawnCalls: { command: string; args: string[] }[];
}

function makeFakeRuntime(): FakeRuntime {
  const timers = new FakeTimers();
  const child = new FakeChild();
  const injected: string[] = [];
  const spawnCalls: { command: string; args: string[] }[] = [];
  const hooks: DelegateRuntimeHooks = {
    spawn: (command, args) => {
      spawnCalls.push({ command, args });
      return child as unknown as ChildProcess;
    },
    setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeout: (t) => timers.clearTimeout(t),
  };
  return { hooks, timers, child, injected, spawnCalls };
}

/** Async delegation needs a long-lived session mode (print/json downgrade to sync). */
function tuiCtx(): ExtensionContext {
  return {
    mode: "tui",
    cwd: process.cwd(),
    model: { provider: "test", id: "test-model" },
  } as unknown as ExtensionContext;
}

function recordingPi(injected: string[]): ExtensionAPI {
  return { sendUserMessage: (text: string) => { injected.push(text); } } as unknown as ExtensionAPI;
}

async function launchAsyncDelegate(
  rt: FakeRuntime,
  params: { agent?: string; task?: string; timeout?: number },
): Promise<string> {
  const tool = makeDelegateTool(recordingPi(rt.injected), undefined, rt.hooks);
  const res = await tool.execute(
    "c1",
    { agent: params.agent ?? "reviewer", task: params.task ?? "t", async: true, timeout: params.timeout ?? 5 },
    undefined,
    undefined,
    tuiCtx(),
  );
  const content = res.content[0];
  const text = content && "text" in content ? content.text : "";
  assert.ok(text.startsWith("Delegated to"), `async delegation text: ${text}`);
  assert.equal(rt.child.unrefCalls, 1, "async child is unref'd");
  return text;
}

function extractRunId(text: string): string {
  const m = /runId `(del_[a-z0-9_]+)`/.exec(text);
  assert.ok(m, `runId in: ${text}`);
  return m[1]!;
}

/** Wait until `pred` holds, polling with real (short) timers. Used to let the
 *  close handler's async persist → finalize chain complete. The poll timer is
 *  always resolved before the test ends — no dangling timers. */
async function settleUntil(pred: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("settleUntil: condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

test("async timeout: effective timeout fires SIGTERM and finalizes as timed_out", async () => {
  const rt = makeFakeRuntime();
  const text = await launchAsyncDelegate(rt, { timeout: 2 });
  const runId = extractRunId(text);

  assert.equal(rt.child.killed.length, 0, "no kill before the timeout fires");
  assert.equal(rt.timers.scheduled.length, 1, "exactly one timer scheduled");
  assert.equal(rt.timers.scheduled[0]!.ms, 2000, "per-call timeout (2s) is the effective timeout");
  assert.equal(rt.timers.pending(), 1, "timeout timer pending");

  rt.timers.advance(2000);
  assert.deepEqual(rt.child.killed, ["SIGTERM"], "timeout sends SIGTERM");
  assert.equal(rt.timers.pending(), 1, "grace timer now pending");

  // Child exits after SIGTERM; finalize must produce exactly one notification.
  rt.child.emit("close", 143);
  await settleUntil(() => rt.injected.length === 1);
  assert.match(rt.injected[0]!, /\[acp_delegate timed out\]/, "timed_out notification text");
  assert.match(rt.injected[0]!, /exit 143/, "exit code reported in notification");
  assert.equal(rt.injected[0]!.includes("failed"), false, "must not read as failed");
  assert.equal(rt.timers.pending(), 0, "no dangling timers after close");
  assert.equal(runId.length > 0, true);
});

test("async timeout: grace fires SIGKILL when the child ignores SIGTERM", async () => {
  const rt = makeFakeRuntime();
  await launchAsyncDelegate(rt, { timeout: 2 });

  rt.timers.advance(2000);
  assert.deepEqual(rt.child.killed, ["SIGTERM"]);
  assert.equal(rt.timers.pending(), 1, "grace timer armed");

  rt.timers.advance(5000);
  assert.deepEqual(rt.child.killed, ["SIGTERM", "SIGKILL"], "grace escalates to SIGKILL");
  assert.equal(rt.timers.pending(), 0, "grace fired, no timers left");

  rt.child.emit("close", null);
  await settleUntil(() => rt.injected.length === 1);
  assert.match(rt.injected[0]!, /\[acp_delegate timed out\]/, "still timed_out after SIGKILL");
  assert.equal(rt.timers.pending(), 0);
});

test("async timeout: close after timeout finalizes exactly once", async () => {
  const rt = makeFakeRuntime();
  await launchAsyncDelegate(rt, { timeout: 2 });
  rt.timers.advance(2000);
  assert.deepEqual(rt.child.killed, ["SIGTERM"]);

  rt.child.emit("close", 143);
  await settleUntil(() => rt.injected.length === 1);
  await settle(); // extra turn: a second finalize would inject again here
  assert.equal(rt.injected.length, 1, "finalize exactly once");
  assert.match(rt.injected[0]!, /\[acp_delegate timed out\]/);

  rt.timers.advance(10_000);
  assert.deepEqual(rt.child.killed, ["SIGTERM"], "no delayed kill after finalize");
  assert.equal(rt.timers.pending(), 0);
});

test("wait during timeout grace: parks a waiter (no persist error), then returns timed_out result once", async () => {
  const rt = makeFakeRuntime();
  const text = await launchAsyncDelegate(rt, { timeout: 2 });
  const runId = extractRunId(text);

  rt.timers.advance(2000);
  assert.deepEqual(rt.child.killed, ["SIGTERM"], "timeout fired");
  assert.equal(rt.timers.pending(), 1, "grace timer pending — child still alive");

  const waitTool = makeDelegateWaitTool(recordingPi(rt.injected));
  let resolved: string | null = null;
  const waitPromise = waitTool
    .execute("w1", { runId }, undefined, undefined, tuiCtx())
    .then((res) => {
      const c = res.content[0];
      resolved = c && "text" in c ? c.text ?? null : null;
      return res;
    });

  // During the grace window the run is terminating (non-terminal): wait must
  // park, NOT report "finished but no result (persist error)" and NOT consume.
  await settle();
  assert.equal(resolved, null, "wait must not resolve while the run is terminating");
  // A second wait sees a parked waiter — proof the run is still tracked and
  // not treated as terminal.
  const res2 = await waitTool.execute("w2", { runId }, undefined, undefined, tuiCtx());
  const c2 = res2.content[0];
  const t2 = c2 && "text" in c2 ? c2.text : "";
  assert.match(t2, /already has a wait in progress/, "run still tracked as non-terminal during grace");

  rt.child.emit("close", 143);
  await waitPromise;
  assert.ok(resolved, "wait resolves after close");
  assert.match(resolved!, /timed out/, "wait returns timed_out result after close");
  assert.match(resolved!, /exit 143/, "exit code reported");
  assert.match(resolved!, /Full result: /, "result file present");
  assert.equal(rt.injected.length, 0, "waiter owns the result: no duplicate notification");
  assert.equal(rt.timers.pending(), 0, "no dangling timers after finalize");
});

test("cancel before timeout clears timers, cancels, and never kills again", async () => {
  const rt = makeFakeRuntime();
  const text = await launchAsyncDelegate(rt, { timeout: 5 });
  const runId = extractRunId(text);

  const cancelTool = makeDelegateCancelTool(recordingPi(rt.injected), rt.hooks);
  const res = await cancelTool.execute("c2", { runId }, undefined, undefined, tuiCtx());
  const content = res.content[0];
  const cancelText = content && "text" in content ? content.text : "";
  assert.match(cancelText, /Cancelled/, "cancel acknowledgment");

  assert.deepEqual(rt.child.killed, ["SIGTERM"], "cancel itself sends SIGTERM");
  assert.equal(rt.timers.scheduled.length, 1, "timeout timer had been scheduled");
  assert.equal(rt.timers.clearedIds.length, 1, "timeout timer cleared by cancel");
  assert.equal(rt.timers.pending(), 0, "no timers remain after cancel");

  rt.timers.advance(10_000);
  assert.deepEqual(rt.child.killed, ["SIGTERM"], "no timeout SIGTERM and no grace SIGKILL after cancel");

  rt.child.emit("close", null);
  await settle();
  assert.equal(rt.injected.length, 0, "cancelled runs never inject a notification");
  assert.equal(rt.timers.pending(), 0);
});

test("normal close clears timers, injects completed, and never kills late", async () => {
  const rt = makeFakeRuntime();
  await launchAsyncDelegate(rt, { timeout: 5 });

  rt.child.emit("close", 0);
  await settleUntil(() => rt.injected.length === 1);
  assert.match(rt.injected[0]!, /\[acp_delegate completed\]/, "completed notification");
  assert.equal(rt.timers.pending(), 0, "timeout timer cleared on close");
  assert.equal(rt.timers.clearedIds.length, 1, "timeout timer cleared (grace never scheduled)");

  rt.timers.advance(10_000);
  assert.deepEqual(rt.child.killed, [], "no delayed kill after normal close");
});

test("spawn error clears timers and never kills late", async () => {
  const rt = makeFakeRuntime();
  await launchAsyncDelegate(rt, { timeout: 5 });

  rt.child.emit("error", new Error("boom"));
  await settle();
  assert.equal(rt.timers.pending(), 0, "timers cleared on spawn error");
  assert.equal(rt.timers.clearedIds.length, 1, "timeout timer cleared (grace never scheduled)");
  assert.equal(rt.injected.length, 0, "spawn-error path does not inject (by design)");

  rt.timers.advance(10_000);
  assert.deepEqual(rt.child.killed, [], "no delayed kill after error");
});

test("non-zero exit injects a failed notification (distinct from timed_out)", async () => {
  const rt = makeFakeRuntime();
  await launchAsyncDelegate(rt, { timeout: 5 });

  rt.child.emit("close", 1);
  await settleUntil(() => rt.injected.length === 1);
  assert.match(rt.injected[0]!, /\[acp_delegate failed\]/, "failed notification text");
  assert.match(rt.injected[0]!, /exit 1/, "exit code reported");
  assert.equal(rt.injected[0]!.includes("timed out"), false, "must not read as timed out");
  assert.equal(rt.timers.pending(), 0);
});

// ─── Unconfigured agentDir: built-in compat (T1-S6.5) ───────────────────────
// Regression: with NO agentDir, built-in roles must keep their established
// restricted behavior — base + ACP tools allowlist (no edit/write) for the
// read-only roles, ambient (no --tools) for worker, and the built-in prompt
// and model defaults unchanged.

test("unconfigured agentDir: built-in restricted roles keep source + allowlist in dryRun", async () => {
  for (const role of RESTRICTED_ROLES) {
    const plan = await dryRunPlan(undefined, { agent: role, task: "x", dryRun: true });
    assert.ok(plan.includes("- source: built-in"), `${role}: resolves as built-in`);
    assert.ok(
      plan.includes("read, bash, grep, find, ls, compress, decompress, search_context, acp_status (--tools allowlist)"),
      `${role}: restricted base + ACP allowlist`,
    );
    assert.ok(!plan.includes("edit"), `${role}: no edit tool`);
    assert.ok(!plan.includes("write"), `${role}: no write tool`);
  }
  const workerPlan = await dryRunPlan(undefined, { agent: "worker", task: "x", dryRun: true });
  assert.ok(
    workerPlan.includes("ambient (full default toolset, no --tools restriction)"),
    "worker stays ambient (no allowlist)",
  );
});

test("unconfigured agentDir: built-in reviewer spawn args + prompt unchanged (fake spawn)", async () => {
  const rt = makeFakeRuntime();
  const tool = makeDelegateTool(recordingPi(rt.injected), undefined, rt.hooks);

  await tool.execute("c1", { agent: "reviewer", task: "t", async: true, timeout: 5 }, undefined, undefined, tuiCtx());
  assert.equal(rt.spawnCalls.length, 1, "one spawn for reviewer");
  const spawnArgs = rt.spawnCalls[0]!.args;
  const toolsStr = getToolsValue(spawnArgs);
  assert.ok(toolsStr, "reviewer gets --tools");
  assert.deepEqual(
    toolsStr!.split(","),
    ["read", "bash", "grep", "find", "ls", "compress", "decompress", "search_context", "acp_status"],
    "exact restricted base + ACP allowlist, in order",
  );
  assert.ok(!toolsStr!.includes("edit") && !toolsStr!.includes("write"), "no edit/write");

  // Model default unchanged: inherited from ctx (provider/id split).
  const providerIdx = spawnArgs.indexOf("--provider");
  const modelIdx = spawnArgs.indexOf("--model");
  assert.ok(providerIdx >= 0 && modelIdx >= 0, "model inherited from ctx");
  assert.equal(spawnArgs[providerIdx + 1], "test");
  assert.equal(spawnArgs[modelIdx + 1], "test-model");

  // Built-in prompt preserved in the role.md written for the child.
  const promptFile = spawnArgs[spawnArgs.indexOf("--append-system-prompt") + 1]!;
  const promptContent = await readFile(promptFile, "utf8");
  assert.ok(
    promptContent.includes("You are a senior code reviewer with read-only access."),
    "built-in reviewer prompt preserved verbatim",
  );

  // Worker: still ambient — no --tools on the real spawn path.
  await tool.execute("c2", { agent: "worker", task: "t2", async: true, timeout: 5 }, undefined, undefined, tuiCtx());
  assert.equal(rt.spawnCalls.length, 2, "second spawn for worker");
  assert.equal(getToolsValue(rt.spawnCalls[1]!.args), null, "worker spawn has no --tools");

  // Cleanup: finalize both runs, no dangling timers.
  rt.child.emit("close", 0);
  await settle();
  rt.child.emit("close", 0);
  await settle();
  assert.equal(rt.timers.pending(), 0, "no dangling timers");
});
