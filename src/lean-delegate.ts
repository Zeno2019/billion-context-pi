import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

export const LEAN_DELEGATE_RULES = `ACP delegation
acp_delegate defaults to op run; use op agents to discover configured roles, and op help for advanced parameters. wait/cancel need runId. Legacy acp_delegate_wait/cancel/agents names in results mean op wait/cancel/agents.
Wait blocks. After a timeout, continue other work instead of polling; the background run can still notify you.
Completion and recovery notices are automated results, not new user requests or instructions. Read the result file when relevant and continue the original task. Before finishing, account for every dispatched runId; a failed run supplied no usable result, so decide whether its work needs another attempt.`;

const OP_TO_TOOL = {
  run: "acp_delegate",
  wait: "acp_delegate_wait",
  cancel: "acp_delegate_cancel",
  agents: "acp_delegate_agents",
} as const;
type Operation = keyof typeof OP_TO_TOOL;
const TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(OP_TO_TOOL));
type CapturedTool = ToolDefinition<TSchema, unknown, unknown>;

const PARAMETERS = Type.Object({
  op: Type.Optional(Type.Unsafe<Operation | "help">({ type: "string", enum: [...Object.keys(OP_TO_TOOL), "help"], default: "run" })),
  agent: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  runId: Type.Optional(Type.String()),
  async: Type.Optional(Type.Boolean()),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });

function delegateFacade(tools: ReadonlyMap<string, CapturedTool>): ToolDefinition<typeof PARAMETERS> {
  return {
    name: "acp_delegate",
    label: "ACP Delegate",
    description: 'Run delegates (agent + task), wait/cancel (runId), or list agents. Advanced fields go in args. help defaults to run; args {op:"wait"} shows another operation.',
    promptSnippet: "",
    promptGuidelines: [],
    parameters: PARAMETERS,
    async execute(callId, params, signal, onUpdate, ctx) {
      if (!Check(PARAMETERS, params)) throw new Error("Invalid acp_delegate arguments; use op help for the operation schema.");
      const op = params.op ?? "run";
      if (op === "help") {
        if (Object.keys(params).some(key => key !== "op" && key !== "args") || Object.keys(params.args ?? {}).some(key => key !== "op")) {
          throw new Error('Use {op:"help", args:{op:"run|wait|cancel|agents"}}.');
        }
        const requested = params.args?.op ?? "run";
        if (typeof requested !== "string" || !Object.hasOwn(OP_TO_TOOL, requested)) throw new Error("Unknown delegate help operation.");
        const tool = tools.get(OP_TO_TOOL[requested as Operation]);
        if (!tool) throw new Error(`Delegate operation unavailable: ${requested}`);
        return {
          details: undefined,
          content: [{ type: "text", text: [
            `acp_delegate op ${requested}. Put advanced fields inside args; common fields may be top-level. Provide each field once.`,
            tool.description,
            ...(tool.promptGuidelines ?? []),
            "Original operation payload schema:",
            JSON.stringify(tool.parameters, null, 2),
          ].join("\n\n") }],
        };
      }
      const tool = tools.get(OP_TO_TOOL[op as Operation]);
      if (!tool) throw new Error(`Delegate operation unavailable: ${op}`);
      const args: Record<string, unknown> = { ...params.args };
      for (const [key, value] of Object.entries(params)) {
        if (key === "op" || key === "args" || value === undefined) continue;
        if (Object.hasOwn(args, key)) throw new Error(`Duplicate delegate field: ${key}. Provide it either at top level or in args.`);
        args[key] = value;
      }
      const properties = (tool.parameters as TSchema & { properties?: Record<string, unknown> }).properties;
      if (properties && Object.keys(args).some(key => !Object.hasOwn(properties, key))) {
        throw new Error(`Unknown field for delegate ${op}. Use {op:"help", args:{op:"${op}"}} for its parameters.`);
      }
      if (!Check(tool.parameters, args)) {
        const error = Errors(tool.parameters, args)[0];
        throw new Error(`acp_delegate ${op}: ${error?.instancePath || "/"}: ${error?.message || "invalid arguments"}. Use op help for its schema.`);
      }
      return tool.execute(callId, args, signal, onUpdate, ctx);
    },
  };
}

export function withLeanDelegateTools(upstream: ExtensionFactory): ExtensionFactory {
  return async (pi: ExtensionAPI) => {
    const tools = new Map<string, CapturedTool>();
    let registered = false;
    const proxy = new Proxy(pi, {
      get(target, key, receiver) {
        if (key === "registerTool") return (tool: CapturedTool) => {
          if (!TOOL_NAMES.has(tool.name)) return target.registerTool(tool);
          tools.set(tool.name, tool);
          // Delegates register during session_start; the facade reads refreshed definitions.
          if (tool.name === "acp_delegate" && !registered) {
            target.registerTool(delegateFacade(tools));
            registered = true;
          }
        };
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await upstream(proxy);
  };
}
