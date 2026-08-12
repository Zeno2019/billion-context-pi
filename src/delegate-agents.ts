import { readFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { debug } from "./log.js";

/** Valid Pi thinking levels. Must match Pi CLI's VALID_THINKING_LEVELS. */
export const VALID_THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** Agent name: alphanumeric, underscore, hyphen only. */
const AGENT_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Maximum agent name length (matches Pi skill name limit for consistency). */
const MAX_NAME_LENGTH = 64;

/** A parsed agent definition loaded from a Markdown file in agentDir. */
export interface AgentDirDef {
  /** Agent name (derived from filename, without .md extension). */
  name: string;
  /** System prompt body (Markdown after frontmatter). Must be non-empty. */
  prompt: string;
  /** Model override as "provider/id", or undefined to inherit parent. */
  model?: string;
  /** Thinking level override, or undefined. */
  thinking?: string;
  /** Comma-separated tool allowlist, or undefined for full default toolset. */
  tools?: string[];
  /** Timeout in seconds for the delegate run, or undefined for no timeout. */
  timeout?: number;
  /** Model allowlist (validated, not auto-fallback). Comma-separated. */
  allowedModels?: string[];
  /** Absolute path to the source .md file. */
  sourcePath: string;
}

/** Result of loading a single agent file. */
export type LoadAgentResult =
  | { ok: true; def: AgentDirDef }
  | { ok: false; name: string; sourcePath: string; reason: string };

/** Expand `~` and `~/` in a path. Returns the original if no tilde prefix. */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Verify that a resolved path is inside the given root directory.
 *  Uses realpath to detect symlink escapes. Returns true if contained. */
async function isPathContained(
  filePath: string,
  rootDir: string,
): Promise<boolean> {
  try {
    const realFile = await realpath(filePath);
    const realRoot = await realpath(rootDir);
    const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    return realFile === realRoot || realFile.startsWith(prefix);
  } catch {
    return false;
  }
}

/** Parse simple frontmatter from Markdown.
 *
 * Expects:
 * ```
 * ---
 * key: value
 * key2: value2
 * ---
 * body text...
 * ```
 *
 * Returns `{ frontmatter: Record<string, string>, body: string }`.
 * If no frontmatter delimiter is found, returns empty frontmatter + full text as body.
 * Values are raw strings (not typed); callers validate.
 */
function parseFrontmatter(
  raw: string,
): { frontmatter: Record<string, string>; body: string } {
  const lines = raw.split("\n");
  if (lines.length === 0 || lines[0]!.trim() !== "---") {
    return { frontmatter: {}, body: raw.trim() };
  }
  const fm: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "---") break;
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key.length > 0) fm[key] = value;
  }
  const body = lines.slice(i + 1).join("\n").trim();
  return { frontmatter: fm, body };
}

/** Parse a comma-separated string into a trimmed, filtered, deduplicated
 *  array of non-empty strings. */
function parseList(value: string): string[] {
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...new Set(items)];
}

/** Parse and validate a single agent file. Does NOT throw; returns a
 *  typed error result for any validation failure. */
async function loadAgentFile(
  filePath: string,
  expectedName: string,
): Promise<LoadAgentResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (e) {
    return {
      ok: false,
      name: expectedName,
      sourcePath: filePath,
      reason: `read error: ${(e as Error).message}`,
    };
  }

  const { frontmatter, body } = parseFrontmatter(raw);

  if (!body || body.trim().length === 0) {
    return {
      ok: false,
      name: expectedName,
      sourcePath: filePath,
      reason: "prompt body is empty",
    };
  }

  const def: AgentDirDef = {
    name: expectedName,
    prompt: body,
    sourcePath: filePath,
  };

  if (frontmatter.model !== undefined && frontmatter.model.length > 0) {
    def.model = frontmatter.model;
  }

  if (frontmatter.thinking !== undefined && frontmatter.thinking.length > 0) {
    if (!VALID_THINKING_LEVELS.has(frontmatter.thinking)) {
      return {
        ok: false,
        name: expectedName,
        sourcePath: filePath,
        reason: `invalid thinking level "${frontmatter.thinking}"; valid: ${[...VALID_THINKING_LEVELS].join(", ")}`,
      };
    }
    def.thinking = frontmatter.thinking;
  }

  if (frontmatter.tools !== undefined && frontmatter.tools.length > 0) {
    def.tools = parseList(frontmatter.tools);
  }

  if (
    frontmatter["allowed-models"] !== undefined &&
    frontmatter["allowed-models"].length > 0
  ) {
    def.allowedModels = parseList(frontmatter["allowed-models"]);
  }

  if (frontmatter.timeout !== undefined && frontmatter.timeout.length > 0) {
    const timeoutNum = Number(frontmatter.timeout);
    if (!Number.isInteger(timeoutNum) || timeoutNum <= 0) {
      return {
        ok: false,
        name: expectedName,
        sourcePath: filePath,
        reason: `invalid timeout "${frontmatter.timeout}"; must be a positive integer (seconds)`,
      };
    }
    def.timeout = timeoutNum;
  }

  return { ok: true, def };
}

/** Validate an agent name. Returns an error string if invalid, null if OK. */
export function validateAgentName(name: string): string | null {
  if (name.length === 0) return "agent name is empty";
  if (name.length > MAX_NAME_LENGTH)
    return `agent name exceeds ${MAX_NAME_LENGTH} characters`;
  if (!AGENT_NAME_RE.test(name))
    return `agent name "${name}" contains invalid characters (allowed: A-Z, a-z, 0-9, _, -)`;
  if (name.includes("\0")) return "agent name contains NUL";
  return null;
}

/** Resolve the agentDir from a config value. Handles `~` expansion.
 *  Returns undefined if agentDir is not configured (opt-in). */
export function resolveAgentDir(agentDir?: string): string | undefined {
  if (!agentDir || agentDir.trim().length === 0) return undefined;
  return resolve(expandTilde(agentDir.trim()));
}

/** Load all agent definitions from a directory.
 *
 * Reads `<agentDir>/*.md` files, parses frontmatter, validates fields.
 * Does NOT know about built-in agents - callers merge separately.
 *
 * Returns a Map keyed by agent name. On per-file errors, the file is skipped
 * and logged via debug.event; the error is NOT thrown (fail-closed at the
 * individual-file level: a broken file doesn't break the whole directory).
 *
 * Security:
 * - Agent names are validated (regex, length, NUL).
 * - File paths must be contained within agentDir (realpath check prevents
 *   symlink escape).
 * - Path traversal via filename (e.g. `../foo.md`) is rejected by name regex.
 */
export async function loadAgentDefs(
  agentDir: string,
): Promise<Map<string, AgentDirDef>> {
  const result = new Map<string, AgentDirDef>();
  const resolvedDir = resolve(agentDir);

  let entries: import("node:fs").Dirent[];
  try {
    const { readdir } = await import("node:fs/promises");
    entries = await readdir(resolvedDir, { withFileTypes: true });
  } catch (e) {
    debug.event("delegate-agents-readdir-error", {
      dir: resolvedDir,
      error: String(e),
    });
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;

    const baseName = entry.name.slice(0, -3);
    const nameError = validateAgentName(baseName);
    if (nameError) {
      debug.event("delegate-agents-name-rejected", {
        file: entry.name,
        reason: nameError,
      });
      continue;
    }

    const filePath = join(resolvedDir, entry.name);
    const contained = await isPathContained(filePath, resolvedDir);
    if (!contained) {
      debug.event("delegate-agents-path-escape", {
        file: entry.name,
        dir: resolvedDir,
      });
      continue;
    }

    const loadResult = await loadAgentFile(filePath, baseName);
    if (!loadResult.ok) {
      debug.event("delegate-agents-load-error", {
        name: loadResult.name,
        reason: loadResult.reason,
      });
      continue;
    }

    if (result.has(baseName)) {
      debug.event("delegate-agents-duplicate", { name: baseName });
      continue;
    }

    result.set(baseName, loadResult.def);
    debug.event("delegate-agents-loaded", {
      name: baseName,
      hasModel: !!loadResult.def.model,
      hasThinking: !!loadResult.def.thinking,
      hasTools: !!loadResult.def.tools,
      hasTimeout: !!loadResult.def.timeout,
    });
  }

  return result;
}

/** Load a single agent definition by name from agentDir.
 *
 * Returns:
 * - `{ ok: true, def }` on success.
 * - `{ ok: false, reason: string }` on any failure (validation error, path
 *   escape, or read error — including a missing file, which surfaces as a
 *   read error reason).
 *
 * NOTE: callers must check file existence first (e.g. via `access`) to
 * distinguish "not found" (fall back to built-in) from "invalid" (fail
 * closed); this function reports both as `ok: false`.
 */
export async function loadAgentDef(
  name: string,
  agentDir: string,
): Promise<{ ok: true; def: AgentDirDef } | { ok: false; reason: string }> {
  const nameError = validateAgentName(name);
  if (nameError) return { ok: false, reason: nameError };

  const resolvedDir = resolve(agentDir);
  const filePath = join(resolvedDir, `${name}.md`);
  const contained = await isPathContained(filePath, resolvedDir);
  if (!contained) return { ok: false, reason: "path escape detected" };

  const result = await loadAgentFile(filePath, name);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, def: result.def };
}

/** A discovered agent entry - valid or invalid. Used by the agent discovery
 *  tool to list all agents including those that failed to load. */
export interface DiscoveredAgent {
  name: string;
  ok: boolean;
  def?: AgentDirDef;
  error?: string;
}

/** Scan agentDir for all .md files and return their load status.
 *
 * Unlike `loadAgentDefs` which silently skips errors, this function returns
 * ALL entries (including invalid ones with error reasons) so the discovery
 * tool can report them. Does NOT throw on per-file errors.
 */
export async function discoverAgentDefs(
  agentDir: string,
): Promise<DiscoveredAgent[]> {
  const result: DiscoveredAgent[] = [];
  const resolvedDir = resolve(agentDir);

  let entries: import("node:fs").Dirent[];
  try {
    const { readdir } = await import("node:fs/promises");
    entries = await readdir(resolvedDir, { withFileTypes: true });
  } catch (e) {
    debug.event("delegate-agents-discover-readdir-error", {
      dir: resolvedDir,
      error: String(e),
    });
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;

    const baseName = entry.name.slice(0, -3);
    const nameError = validateAgentName(baseName);
    if (nameError) {
      result.push({ name: baseName, ok: false, error: nameError });
      continue;
    }

    const filePath = join(resolvedDir, entry.name);
    const contained = await isPathContained(filePath, resolvedDir);
    if (!contained) {
      result.push({ name: baseName, ok: false, error: "path escape detected" });
      continue;
    }

    const loadResult = await loadAgentFile(filePath, baseName);
    if (!loadResult.ok) {
      result.push({ name: baseName, ok: false, error: loadResult.reason });
      continue;
    }

    result.push({ name: baseName, ok: true, def: loadResult.def });
  }

  return result;
}
