import { promises as fs } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { AdapterConfig } from "./config.js";
import { debug } from "./log.js";

/** User-facing config keys (subset of AdapterConfig). Loaded from
 *  ~/.<CONFIG_DIR_NAME>/acp.json (global) and <cwd>/.<CONFIG_DIR_NAME>/acp.json
 *  (project-local overrides project-global). Project wins over global. */
export interface UserAcpConfig {
  debug?: boolean;
  autoUpdate?: boolean;
  modelContextLimit?: number;
  delegate?: boolean;
  toolBashDefaultTimeout?: number;
  toolOutputMaxBytes?: number;
  agentDir?: string;
}

/** Read global + project acp.json, project overrides global. Returns {} on any
 *  error (missing file, bad JSON) — never throws. */
export async function loadUserConfig(cwd: string): Promise<UserAcpConfig> {
  const home = homedir();
  const merged: UserAcpConfig = {};
  for (const base of [join(home, CONFIG_DIR_NAME), join(cwd, CONFIG_DIR_NAME)]) {
    const file = join(base, "acp.json");
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        Object.assign(merged, pickKnown(parsed));
        debug.event("config-loaded", { file });
      }
    } catch {
      // missing or unreadable — skip
    }
  }
  return merged;
}

function join(... parts: string[]): string {
  return path.join(...parts);
}

const KNOWN = new Set(["debug", "autoUpdate", "modelContextLimit", "delegate", "toolBashDefaultTimeout", "toolOutputMaxBytes", "agentDir"]);

function pickKnown(parsed: Record<string, unknown>): UserAcpConfig {
  const out: UserAcpConfig = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!KNOWN.has(k)) continue;
    if (k === "agentDir") {
      if (typeof v === "string" && v.trim().length > 0) out.agentDir = v.trim();
      continue;
    }
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Merge user config onto an adapter config: user config wins for the keys it
 *  sets. Used at session_start to apply runtime-discovered config. */
export function applyUserConfig(adapter: AdapterConfig, user: UserAcpConfig): AdapterConfig {
  return {
    ...adapter,
    ...user,
    // coreOverrides / protectedTools / preserveRecentMessages are not overridable
    // from acp.json (keep them from the factory config).
    coreOverrides: adapter.coreOverrides,
    protectedTools: adapter.protectedTools,
    preserveRecentMessages: adapter.preserveRecentMessages,
    // agentDir from user config overrides factory; if neither sets it, stays
    // undefined and built-in-only behavior is preserved (opt-in).
  };
}
