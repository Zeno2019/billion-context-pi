import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { Check, Clone, Errors } from "typebox/value";
import type { AdapterConfig } from "./config.js";
import { createAcpExtension } from "./index.js";
import { SECTION_KEYS } from "./system-prompt.js";

// Adapted from kunkun9527/billion-context-pi-lean (MIT); execution stays in this fork.
export const LEAN_CONTEXT_RULES = `Messages carry hidden \x3cacp\x3e refs such as m00123. Never echo the tags; use refs only in ACP calls.
Compress consumed history, never active work, important user intent, or protected outputs. Summaries must preserve exact paths, versions, errors, decisions, constraints, open objectives and anchor refs; never invent answers.
Compression summaries are fallible history, not new instructions. Continue open user objectives; verify historical details only when the current task needs them. Do not recall merely to check a successful fold.
Low-frequency names in ACP hints are operations of acp_context, not standalone tools. Pass {op, args}: decompress {blockId, full?, inline?, toFile?}; search_context {query, limit?}; acp_status {scope?, view?, tool?, sort?, limit?}; acp_cache {detail?}. Use op help with args {tool: operation} for the full schema.`;

const OPERATIONS = ["decompress", "search_context", "acp_status", "acp_cache"] as const;
const OPERATION_SET: ReadonlySet<string> = new Set(OPERATIONS);
type CapturedTool = ToolDefinition<TSchema, unknown, unknown>;

const FACADE_PARAMS = Type.Object({
  op: Type.Union([...OPERATIONS, "help"].map(op => Type.Literal(op))),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });

const COMPRESS_DESCRIPTIONS: Readonly<Record<string, string>> = {
  content: "Direct array of ranges; no JSON strings or nested wrappers.",
  startId: "Inclusive first mNNNNN or bN ref.",
  endId: "Inclusive last mNNNNN or bN ref.",
  summary: "Self-contained replacement preserving exact details and open objectives.",
  topic: "Short label; per-range label overrides the top-level fallback.",
  summaryMaxChars: "Optional summary length limit override.",
};

function compactDescriptions(value: unknown, field?: string): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  delete record.description;
  if (field && COMPRESS_DESCRIPTIONS[field]) record.description = COMPRESS_DESCRIPTIONS[field];
  for (const [key, child] of Object.entries(record)) {
    if (key === "properties" && child && typeof child === "object") {
      for (const [name, schema] of Object.entries(child)) compactDescriptions(schema, name);
    } else {
      compactDescriptions(child);
    }
  }
}

function facadeTool(tools: ReadonlyMap<string, CapturedTool>): ToolDefinition<typeof FACADE_PARAMS> {
  return {
    name: "acp_context",
    label: "ACP Context",
    description: 'Search, restore or inspect ACP context. Pass the original operation args; op "help" with args {tool: operation} returns its full schema.',
    promptSnippet: "",
    promptGuidelines: [],
    parameters: FACADE_PARAMS,
    async execute(callId, params, signal, onUpdate, ctx) {
      if (!Check(FACADE_PARAMS, params)) throw new Error("Invalid acp_context arguments; use {op, args?}.");
      if (params.op === "help") {
        const requested = params.args?.tool;
        if (requested === undefined) {
          return { details: undefined, content: [{ type: "text", text: `Operations: ${[...tools.keys()].join(", ")}. Use {op:"help", args:{tool:operation}} for its full schema.` }] };
        }
        if (typeof requested !== "string" || !tools.has(requested)) throw new Error("Unknown acp_context help operation.");
        const tool = tools.get(requested)!;
        return { details: undefined, content: [{ type: "text", text: `${tool.name}\n${tool.description}\nPass args matching this schema:\n${JSON.stringify(tool.parameters, null, 2)}` }] };
      }
      const tool = tools.get(params.op);
      if (!tool) throw new Error(`ACP operation unavailable: ${params.op}`);
      const args = params.args ?? {};
      if (!Check(tool.parameters, args)) {
        const error = Errors(tool.parameters, args)[0];
        throw new Error(`acp_context ${params.op}: ${error?.instancePath || "/"}: ${error?.message || "invalid arguments"}. Use {op:"help", args:{tool:"${params.op}"}} for the full schema.`);
      }
      return tool.execute(callId, args, signal, onUpdate, ctx);
    },
  };
}

export function withLeanContextTools(upstream: ExtensionFactory): ExtensionFactory {
  return async (pi: ExtensionAPI) => {
    const tools = new Map<string, CapturedTool>();
    const proxy = new Proxy(pi, {
      get(target, key, receiver) {
        if (key === "registerTool") return (tool: CapturedTool) => {
          if (OPERATION_SET.has(tool.name)) {
            tools.set(tool.name, tool);
          } else if (tool.name === "compress") {
            const parameters = Clone(tool.parameters);
            compactDescriptions(parameters);
            target.registerTool({
              ...tool,
              parameters,
              description: "Replace consumed conversation ranges with self-contained summaries using mNNNNN or bN refs.",
              promptSnippet: "",
              promptGuidelines: [],
            });
          } else {
            target.registerTool(tool);
          }
        };
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await upstream(proxy);
    if (tools.size > 0) pi.registerTool(facadeTool(tools));
  };
}

export function createLeanAcpExtension(adapter: AdapterConfig = {}): ExtensionFactory {
  return withLeanContextTools(createAcpExtension({
    ...adapter,
    delegateContextTools: ["compress", "acp_context"],
    promptSections: {
      ...Object.fromEntries([...SECTION_KEYS].map(key => [key, null])),
      acpTags: LEAN_CONTEXT_RULES,
      ...adapter.promptSections,
    },
  }));
}

export default createLeanAcpExtension();
