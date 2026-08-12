import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  validateAgentName,
  resolveAgentDir,
  loadAgentDef,
  loadAgentDefs,
  discoverAgentDefs,
  type AgentDirDef,
} from "../src/delegate-agents.js";

// ─── Fixture helpers ────────────────────────────────────────────────────────
//
// 临时目录在仓库根下创建（受限环境 /tmp 禁写），测试结束后统一清理。
// 不依赖任何外部 fixture 文件。

const fixtureDirs: string[] = [];

async function makeFixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), ".delegate-agents-test-"));
  fixtureDirs.push(dir);
  return dir;
}

/** 写一个 agent md 文件到 fixture 目录。 */
async function writeAgentMd(dir: string, fileName: string, content: string): Promise<string> {
  const filePath = join(dir, fileName);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

/** 标准合法 agent 文件内容。 */
const GOOD_AGENT_MD = `---
name: good-agent
model: openai-codex/gpt-5.6-sol
thinking: high
tools: read, bash, grep, read
timeout: 120
allowed-models: openai-codex/gpt-5.6-sol, anthropic/claude-4.5
---
Do good things carefully.
`;

const BODY_ONLY_MD = `No frontmatter here, just a prompt body.`;

after(async () => {
  for (const dir of fixtureDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── 未配置 agentDir 的缺省行为 ─────────────────────────────────────────────

test("resolveAgentDir returns undefined when agentDir is not configured (opt-in)", () => {
  assert.equal(resolveAgentDir(undefined), undefined);
  assert.equal(resolveAgentDir(""), undefined);
  assert.equal(resolveAgentDir("   "), undefined);
});

test("resolveAgentDir expands ~ and resolves relative paths", () => {
  assert.equal(resolveAgentDir("~"), resolve(homedir()));
  assert.equal(resolveAgentDir("~/agents"), resolve(join(homedir(), "agents")));
  assert.equal(resolveAgentDir("rel/path"), resolve("rel/path"));
  assert.equal(resolveAgentDir("  /abs/path  "), resolve("/abs/path"));
});

// ─── 合法 agent Markdown 字段解析 ────────────────────────────────────────────

test("loadAgentDef parses all supported frontmatter fields", async () => {
  const dir = await makeFixtureDir();
  await writeAgentMd(dir, "good-agent.md", GOOD_AGENT_MD);

  const result = await loadAgentDef("good-agent", dir);
  assert.equal(result.ok, true);
  const def = (result as { ok: true; def: AgentDirDef }).def;
  assert.equal(def.name, "good-agent");
  assert.equal(def.model, "openai-codex/gpt-5.6-sol");
  assert.equal(def.thinking, "high");
  assert.deepEqual(def.tools, ["read", "bash", "grep"]); // 去重 + trim
  assert.equal(def.timeout, 120);
  assert.deepEqual(def.allowedModels, ["openai-codex/gpt-5.6-sol", "anthropic/claude-4.5"]);
  assert.match(def.prompt, /Do good things carefully/);
  assert.ok(def.sourcePath.endsWith(join(dir, "good-agent.md")));
});

test("loadAgentDef accepts a body-only file (no frontmatter) as a plain prompt", async () => {
  const dir = await makeFixtureDir();
  await writeAgentMd(dir, "body-only.md", BODY_ONLY_MD);

  const result = await loadAgentDef("body-only", dir);
  assert.equal(result.ok, true);
  const def = (result as { ok: true; def: AgentDirDef }).def;
  assert.equal(def.model, undefined);
  assert.equal(def.thinking, undefined);
  assert.equal(def.timeout, undefined);
  assert.match(def.prompt, /No frontmatter here/);
});

test("loadAgentDefs scans the directory and ignores non-md files", async () => {
  const dir = await makeFixtureDir();
  await writeAgentMd(dir, "good-agent.md", GOOD_AGENT_MD);
  await writeAgentMd(dir, "another.md", BODY_ONLY_MD);
  await writeFile(join(dir, "notes.txt"), "not an agent", "utf8");

  const defs = await loadAgentDefs(dir);
  assert.deepEqual([...defs.keys()].sort(), ["another", "good-agent"]);
});

test("loadAgentDefs returns an empty map for a missing directory (no throw)", async () => {
  const defs = await loadAgentDefs(join(process.cwd(), ".delegate-agents-does-not-exist"));
  assert.equal(defs.size, 0);
});

test("discoverAgentDefs reports valid entries with ok:true", async () => {
  const dir = await makeFixtureDir();
  await writeAgentMd(dir, "good-agent.md", GOOD_AGENT_MD);

  const discovered = await discoverAgentDefs(dir);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]!.ok, true);
  assert.equal(discovered[0]!.name, "good-agent");
  assert.equal(discovered[0]!.error, undefined);
  assert.equal(discovered[0]!.def?.timeout, 120);
});

// ─── 无效 frontmatter / 字段安全拒绝 ────────────────────────────────────────

test("loadAgentDef rejects an empty prompt body", async () => {
  const dir = await makeFixtureDir();
  await writeAgentMd(dir, "empty.md", "---\nname: empty\n---\n   ");

  const result = await loadAgentDef("empty", dir);
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /prompt body is empty/);
});

test("loadAgentDef rejects an invalid thinking level", async () => {
  const dir = await makeFixtureDir();
  await writeAgentMd(dir, "bad-thinking.md", "---\nthinking: turbo\n---\nbody\n");

  const result = await loadAgentDef("bad-thinking", dir);
  assert.equal(result.ok, false);
  assert.match(
    (result as { ok: false; reason: string }).reason,
    /invalid thinking level "turbo"/,
  );
});

test("loadAgentDef rejects non-positive / non-integer timeouts", async () => {
  for (const bad of ["abc", "0", "-5", "1.5"]) {
    const dir = await makeFixtureDir();
    await writeAgentMd(dir, "bad-timeout.md", `---\ntimeout: ${bad}\n---\nbody\n`);

    const result = await loadAgentDef("bad-timeout", dir);
    assert.equal(result.ok, false, `timeout "${bad}" must be rejected`);
    assert.match(
      (result as { ok: false; reason: string }).reason,
      /invalid timeout/,
      `timeout "${bad}" reason must mention invalid timeout`,
    );
  }
});

test("loadAgentDef treats an empty timeout value as unset (no timeout)", async () => {
  const dir = await makeFixtureDir();
  await writeAgentMd(dir, "empty-timeout.md", "---\ntimeout: \n---\nbody\n");

  const result = await loadAgentDef("empty-timeout", dir);
  assert.equal(result.ok, true);
  const def = (result as { ok: true; def: AgentDirDef }).def;
  assert.equal(def.timeout, undefined);
});

test("discoverAgentDefs keeps valid entries and reports invalid ones with reasons", async () => {
  const dir = await makeFixtureDir();
  await writeAgentMd(dir, "good-agent.md", GOOD_AGENT_MD);
  await writeAgentMd(dir, "broken.md", "---\nthinking: nope\n---\nsome body\n");

  const discovered = await discoverAgentDefs(dir);
  assert.equal(discovered.length, 2);

  const good = discovered.find((d) => d.name === "good-agent");
  assert.ok(good && good.ok);

  const broken = discovered.find((d) => d.name === "broken");
  assert.ok(broken && !broken.ok);
  assert.match(broken.error ?? "", /invalid thinking level "nope"/);
});

// ─── agent name 校验 ────────────────────────────────────────────────────────

test("validateAgentName accepts valid names", () => {
  assert.equal(validateAgentName("reviewer"), null);
  assert.equal(validateAgentName("my-agent_2"), null);
  assert.equal(validateAgentName("A"), null);
});

test("validateAgentName rejects empty, oversized, and invalid-character names", () => {
  assert.match(validateAgentName("") ?? "", /empty/);
  assert.match(validateAgentName("a".repeat(65)) ?? "", /exceeds 64 characters/);
  for (const bad of ["a b", "a.b", "../evil", "a/b", "中文", "a,b"]) {
    assert.ok(validateAgentName(bad) !== null, `name "${bad}" must be rejected`);
  }
  // NUL: regex (^[A-Za-z0-9_-]+$) rejects it first with the generic reason;
  // the dedicated NUL branch is defense-in-depth and unreachable in practice.
  assert.ok(validateAgentName("a\0b") !== null, "name with NUL must be rejected");
});

test("loadAgentDef rejects names that fail validation before touching the filesystem", async () => {
  const dir = await makeFixtureDir();
  const result = await loadAgentDef("../escape", dir);
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /invalid characters/);
});

// ─── realpath containment / 路径穿越 / symlink 逃逸拒绝 ─────────────────────

test("loadAgentDef rejects a symlink escaping agentDir (path escape)", async (t) => {
  const dir = await makeFixtureDir();
  const outsideDir = await makeFixtureDir();
  const outsideFile = join(outsideDir, "secret.md");
  await writeFile(outsideFile, "---\nname: secret\n---\nsecret body\n", "utf8");

  let linked = false;
  try {
    await symlink(outsideFile, join(dir, "evil.md"));
    linked = true;
  } catch {
    // 受限环境（沙箱/macOS 权限）可能禁止 symlink —— 明确 skip，不弱化实现。
    t.skip("symlink creation not permitted in this environment; escape-rejection path is covered by loadAgentDef name validation + containment logic");
    return;
  }
  assert.ok(linked);

  const result = await loadAgentDef("evil", dir);
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /path escape detected/);
});

test("discoverAgentDefs ignores symlink entries (never reads outside agentDir)", async (t) => {
  const dir = await makeFixtureDir();
  const outsideDir = await makeFixtureDir();
  const outsideFile = join(outsideDir, "secret.md");
  await writeFile(outsideFile, "---\nname: secret\n---\nsecret body\n", "utf8");

  try {
    await symlink(outsideFile, join(dir, "evil.md"));
  } catch {
    t.skip("symlink creation not permitted in this environment");
    return;
  }
  // symlink 的 Dirent.isFile() 为 false → 目录扫描跳过它，外部文件永不被加载。
  const discovered = await discoverAgentDefs(dir);
  assert.equal(discovered.length, 0);
});

test("loadAgentDef reports a missing file as a containment rejection (fail-closed)", async () => {
  const dir = await makeFixtureDir();
  // isPathContained realpath() throws ENOENT for a missing file and the
  // containment check fails closed → "path escape detected". resolveAgent
  // pre-checks existence via access() before calling loadAgentDef, so this
  // branch is defensive and only reachable via direct API use.
  const result = await loadAgentDef("ghost", dir);
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /path escape detected/);
});

test("README frontmatter example (comments on separate lines) loads as-is", async () => {
  // 与 README.md / README.zh-CN.md 的 Configurable delegate agents 示例逐行一致。
  // parser 不支持 inline `# ...` 注释，因此文档示例把注释放在独立行
  // （无冒号的行会被 frontmatter 解析跳过），保证用户直接复制即可用。
  const dir = await makeFixtureDir();
  await writeAgentMd(
    dir,
    "reviewer.md",
    `---
# provider/id override (optional)
model: anthropic/claude-4.5
# off|minimal|low|medium|high|xhigh|max (optional)
thinking: high
# allowlist; ACP tools auto-appended (optional)
tools: read, bash, grep
# seconds, positive int (optional)
timeout: 30
# per-call override allowlist (optional)
allowed-models: anthropic/claude-4.5, openai/gpt-5
---
Your system prompt body. Appended to the task via --append-system-prompt.
`,
  );

  const result = await loadAgentDef("reviewer", dir);
  assert.ok(result.ok, `README example must load; got: ${result.ok ? "" : result.reason}`);
  if (result.ok) {
    assert.equal(result.def.model, "anthropic/claude-4.5");
    assert.equal(result.def.thinking, "high");
    assert.deepEqual(result.def.tools, ["read", "bash", "grep"]);
    assert.equal(result.def.timeout, 30);
    assert.deepEqual(result.def.allowedModels, ["anthropic/claude-4.5", "openai/gpt-5"]);
    assert.equal(result.def.prompt, "Your system prompt body. Appended to the task via --append-system-prompt.");
  }
});
