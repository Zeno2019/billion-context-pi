import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { CoreMessage, NudgeDecision, CompressionBlock } from "acp-kernel";
import { renderNudgeText } from "acp-kernel";
import type { AdapterConfig } from "./config.js";
import { createRuntime, type AcpRuntime } from "./runtime.js";
import { makeCompressTool } from "./compress-tool.js";
import { makeDecompressTool } from "./decompress-tool.js";
import { makeSearchTool } from "./search-tool.js";
import { makeStatusTool } from "./status-tool.js";
import { makeDelegateTool, makeDelegateWaitTool, makeDelegateCancelTool, makeDelegateAgentsTool, runningRunsSnapshot } from "./delegate-tool.js";
import { makeCommands } from "./commands.js";
import { coreOutToAgentMessages } from "./messages.js";
import { ACP_SYSTEM_PROMPT, ACP_DELEGATE_PROMPT } from "./system-prompt.js";
import { delegateStatusWidget } from "./fleet-widget.js";
import { wireToolGuardrails } from "./tool-guardrails.js";
import { debug, setDebugEnabled } from "./log.js";
import { collectCoveredMessageIds, estimateTokens, lastUserMessageId } from "./tokens.js";
import { checkForUpdate } from "./update.js";
import { runSetupAndNotify } from "./setup-subagent-tools.js";
import { loadUserConfig, applyUserConfig } from "./user-config.js";

type AgentMessage = SessionMessageEntry["message"];

export function createAcpExtension(adapter: AdapterConfig = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const runtime = createRuntime(adapter);
    wireCompactionDisable(pi);
    wireSessionLifecycle(pi, runtime);
    wireContextTransform(pi, runtime);
    wireSystemPrompt(pi, runtime);
    wireToolGuardrails(pi, runtime);
    pi.registerTool(makeCompressTool(runtime));
    pi.registerTool(makeDecompressTool(runtime));
    pi.registerTool(makeSearchTool(runtime));
    pi.registerTool(makeStatusTool(runtime));
    for (const { name, options } of makeCommands(runtime)) {
      pi.registerCommand(name, options);
    }
  };
}

export default createAcpExtension();

// ACP owns compression; cancel Pi's built-in auto-compaction entirely (mirrors
// opencode-acp requiring opencode's compaction.auto = false).
function wireCompactionDisable(pi: ExtensionAPI): void {
  pi.on("session_before_compact", () => ({ cancel: true }));
}

// (acp_delegate injection is best-effort: sendUserMessage is fire-and-forget
// in pi, and interactive/rpc sessions are long-lived so their main loop
// consumes the follow-up queue naturally — no shutdown drain needed.)

function wireSessionLifecycle(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("session_start", async (_event, ctx) => {
    runtime.store.invalidate();
    runtime.clearNudgeTracking();
    // Load user config (~/.pi/acp.json + project .pi/acp.json) and apply it so
    // debug/terminalNudge/autoUpdate/modelContextLimit are runtime-configurable
    // without env vars or reinstalling.
    try {
      const user = await loadUserConfig(ctx.cwd);
      runtime.setAdapter(applyUserConfig(runtime.adapter, user));
      if (runtime.adapter.debug !== undefined) setDebugEnabled(runtime.adapter.debug);
    } catch {
      // best-effort — fall back to factory/env config
    }
    if (runtime.adapter.delegate !== false) {
      pi.registerTool(makeDelegateTool(pi, runtime.adapter.agentDir));
      pi.registerTool(makeDelegateWaitTool(pi));
      pi.registerTool(makeDelegateCancelTool(pi));
      pi.registerTool(makeDelegateAgentsTool(runtime.adapter.agentDir));
    }
    void checkForUpdate(runtime.adapter.autoUpdate ?? true, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg);
    });
    // Idempotently ensure all builtin pi-subagents have ACP context tools
    // (compress/decompress/search_context/acp_status) in their allowlists.
    // Settings.json is patched safely (backup + optimistic mtime lock + verify).
    void runSetupAndNotify(ctx.hasUI ? (m) => ctx.ui.notify(m) : undefined);
    // Bind the TUI status widget for async delegates. The widget reads the
    // in-memory runs Map (via runningRunsSnapshot) and renders a live list of
    // running delegates below the editor. Only the interactive TUI has a UI;
    // rpc/json/print have hasUI=false and the call is a no-op.
    delegateStatusWidget.setContext(ctx, runningRunsSnapshot);
  });
  pi.on("session_shutdown", () => {
    delegateStatusWidget.dispose();
  });
}

// The core integration: Pi's `context` event fires before every LLM call with the
// messages about to be sent. We run acp-kernel's processTurn (prune + ref-tag +
// nudge decision) and return the transformed AgentMessage[].
function wireContextTransform(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("context", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const release = await runtime.acquireLock(sid);
    try {
      const { state, coreMessages, entries } = await runtime.stateFor(ctx);
      const config = runtime.configFor(ctx);
      const coveredIds = collectCoveredMessageIds(state);
      // Prefer pi's real token count (anchored on provider usage) over our
      // chars/4 estimate — it includes the system prompt, tool schemas, and
      // trailing messages pi has not yet received a usage for. This is what the
      // footer percentage reflects, so nudge usage/growth will match what the
      // user sees.
      const realUsage = ctx.getContextUsage?.();
      const estimated = estimateTokens(coreMessages, coveredIds);
      const tokenCount = realUsage?.tokens && realUsage.tokens > 0 ? realUsage.tokens : estimated;

      debug.event("context-in", {
        sid,
        eventMsgs: event.messages?.length ?? 0,
        entries: entries.length,
        coreMsgs: coreMessages.length,
        tokenCount,
        estimatedTokens: estimated,
        realTokens: realUsage?.tokens ?? null,
        realPercent: realUsage?.percent ?? null,
        limit: config.modelContextLimit,
        blocksBefore: state.blocks.length,
        activeBefore: state.blocks.filter((b) => b.active).length,
      });

      const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount });
      await runtime.save(turn.state, ctx);

      debug.event("processTurn", {
        outMsgs: turn.messages.length,
        summaryMsgs: turn.messages.filter((m) => m.id.startsWith("acp_summary")).length,
        prunedMsgs: coreMessages.length - turn.messages.length + turn.messages.filter((m) => m.id.startsWith("acp_summary")).length,
        nudgeShouldInject: turn.nudge?.shouldInject ?? false,
        nudgeReason: turn.nudge?.reason ?? null,
        nudgeVoice: turn.nudge ? renderNudgeText(turn.nudge).voice : null,
      nudgePct: turn.nudge ? Math.round(turn.nudge.contextUsage * 100) : null,
      nudgeTier: turn.nudge?.tier ?? null,
      nudgeCompressibleCount: turn.nudge?.compressibleRanges.length ?? 0,
      nudgeProtectedCount: turn.nudge?.protectedRanges?.length ?? 0,
      nothingToCompress: turn.nudge?.reason?.includes("nothing to compress") ?? false,
      blocksAfter: turn.state.blocks.length,
      activeAfter: turn.state.blocks.filter((b) => b.active).length,
    });

    const originalById = collectOriginals(entries);
    const rebuilt = coreOutToAgentMessages(turn.messages, originalById);
    const debugOn = debug.enabled;

    if (turn.nudge?.shouldInject) {
      // Two independent channels for the nudge:
      //  1. CONTEXT injection (always on): the nudge is appended to the
      //     messages returned to the LLM so the model sees it and compresses.
      //     This is a per-turn append — the next context event rebuilds the
      //     array from scratch, so it does NOT permanently pollute context.
      //  2. TERMINAL echo (debug only): when debug is on, also print the exact
      //     text via ctx.ui.notify so the user can observe what is being
      //     injected while debugging. The model never sees terminal output.
      // Emergency nudges (usage >= 80%) bypass the per-turn dedup so the
      // overflow warning always reaches the model. Other nudges inject at most
      // once per turn: pi fires the context event multiple times per assistant
      // reply (streaming/tool loop), and without this gate the same nudge
      // would be appended on every event.
      const emergency = turn.nudge.breakdown?.emergencyOverride === 1;
      const turnKey = lastUserMessageId(entries) ?? sid;
      const alreadyShown = !emergency && runtime.nudgeShownFor(turnKey);
      if (!alreadyShown) {
        rebuilt.push(nudgeMessage(turn.nudge, turn.state.blocks.filter((b) => b.active)));
        const rendered = renderNudgeText(turn.nudge);
        const top = [...turn.nudge.compressibleRanges].sort((a, b) => b.tokens - a.tokens)[0];
        const example = top ? `\n\nExample: compress({ content: [{ startId: "${top.startRef}", endId: "${top.endRef}", summary: "..." }] })` : "";
        if (debugOn && ctx.hasUI) {
          ctx.ui.notify(`[ACP nudge → context]${emergency ? " [EMERGENCY]" : ""}\n${rendered.text}${example}`);
        }
        if (!emergency) runtime.markNudgeShown(turnKey);
        debug.event("nudge-injected", { sid: ctx.sessionManager.getSessionId(), voice: rendered.voice, channels: ["context", debugOn ? "terminal" : null].filter(Boolean), emergency, turnKey, text: rendered.text + example });
      } else {
        debug.event("nudge-suppressed", { sid: ctx.sessionManager.getSessionId(), turnKey, reason: turn.nudge.reason });
      }
    }

    // Always return the transformed array: every message needs its [mNNNNN] ref
    // tag applied, so there is no meaningful "no change" case to short-circuit.
    debug.event("context-out", { outMsgs: rebuilt.length, injected: turn.nudge?.shouldInject ?? false, emergency: turn.nudge?.breakdown?.emergencyOverride === 1 });
    // Also check for updates here (not only on session_start): resuming a
    // long-running session never re-fires session_start, so an update could
    // go unnoticed for days. checkForUpdate throttles internally (3 min) and
    // is guarded against concurrent calls, so firing it per LLM call is safe.
    void checkForUpdate(runtime.adapter.autoUpdate ?? true, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg);
    });
    return { messages: rebuilt };
    } finally {
      release();
    }
  });
}

function wireSystemPrompt(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("before_agent_start", (event) => {
    const delegate = runtime.adapter.delegate !== false;
    const prompt = delegate ? `${ACP_SYSTEM_PROMPT}\n${ACP_DELEGATE_PROMPT}` : ACP_SYSTEM_PROMPT;
    return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
  });
}

function collectOriginals(entries: ReturnType<ExtensionContext["sessionManager"]["buildContextEntries"]>): Map<string, AgentMessage> {
  const map = new Map<string, AgentMessage>();
  for (const entry of entries) {
    if (entry.type === "message") {
      map.set(entry.id, entry.message);
    } else if (entry.type === "custom_message") {
      // Pi's convertToLlm projects custom messages as { role: "user", content }
      // for the LLM. Mirror that here so coreOutToAgentMessages restores a
      // proper user AgentMessage — using role:"custom" would be dropped by Pi.
      const content = typeof entry.content === "string"
        ? [{ type: "text" as const, text: entry.content }]
        : entry.content;
      map.set(entry.id, { role: "user", content } as AgentMessage);
    }
  }
  return map;
}

function nudgeMessage(nudge: NudgeDecision, blocks: CompressionBlock[]): AgentMessage {
  const rendered = renderNudgeText(nudge);
  const lines = [rendered.text];

  if (blocks.length > 0) {
    const totalSummary = blocks.reduce((s, b) => s + Math.ceil((b.summary || "").length / 4), 0);
    const totalCompressed = blocks.reduce((s, b) => s + (b.compressedTokens || 0), 0);
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`);
    const tierCounts: Record<number, number> = {};
    for (const b of blocks) {
      const t = b.tier ?? 1;
      tierCounts[t] = (tierCounts[t] || 0) + 1;
    }
    const tierStr = Object.keys(tierCounts).map(Number).sort().map((t) => `T${t}:${tierCounts[t]}`).join(" ");
    const ids = blocks.slice(0, 10).map((b) => b.blockId).join(", ");
    const extra = blocks.length > 10 ? ` (+${blocks.length - 10} more)` : "";
    lines.push("");
    lines.push(`Compressed blocks: ${blocks.length} active (${tierStr}) — ${fmt(totalSummary)} summary, ${fmt(totalCompressed)} original compressed. Blocks: ${ids}${extra}.`);
  }

  return {
    role: "user",
    content: [{ type: "text", text: lines.join("\n") }],
    timestamp: Date.now(),
  } as AgentMessage;
}
