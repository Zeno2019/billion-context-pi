# Local BCP lean profile / 本地 BCP lean 配置

## 中文

此 fork 已合并正式上游 `v0.1.83`（`1cb6340`），保留 `f9757ee` 引入的自定义代理定义。Pi 固定为 **0.87.1**，`acp-kernel` 固定为 **0.0.98**。参考 [kunkun9527/billion-context-pi-lean](https://github.com/kunkun9527/billion-context-pi-lean/tree/d0b3c396739a17f97dd9dac2d7dd690d000f13fc)（`0.2.1`，基于 `0.1.83`）的工具合并及短提示思路，仅移植这个范围。

- Pi 从 `dist/lean.js` 加载；原 `dist/index.js` 工厂仍供程序调用和上游测试使用。`src/lean.ts` 调用本 fork 的工厂，复用现有 `promptSections` 配置机制，没有替换事件钩子。
- `compress` 保持原名、schema 约束、执行与结果，仅精简说明。`decompress`、`search_context`、`acp_status`、`acp_cache` 合并为 `acp_context({op,args})`；冷门参数通过 `{op:"help",args:{tool:"decompress"}}` 查询。派发前按原 schema 校验。
- 召回正文、压缩结果、持久化细节与进度回调原样转发；上游提示中的旧工具名视为 `acp_context` 的操作名，不对历史内容做文本替换。
- 委派能力收敛为单个 `acp_delegate`，支持 `run`（默认）、`wait`、`cancel`、`agents`、`help`。常用参数 `agent/task/runId/async` 直接显示；模型、思考级别、工作目录、超时、dryRun、resumeFrom 等原有高级参数通过 `args` 传入。`{op:"help"}` 默认展示 run 的原 schema；`{op:"help",args:{op:"wait"}}` 展示其他操作。字段重复或不属于该操作时拒绝派发，不做静默覆盖。
- 首次委派前，如果尚不了解代理及其设置，先调用 `{op:"agents"}`；已有名单可复用，配置改变后再查询。名单按需返回公开职责、默认模型、`allowed-models`、思考等级等，不常驻注入。职责来自 Markdown 的单行 `description`（空白归一，最多 240 字符），不摘取私有角色正文；现有六个代理文件均无需修改。
- 模型链保持原样：`args.model` > 代理文件 `model` > 角色配置 `model` > 父模型。思考链：`args.thinkingLevel` > 代理文件 `thinking` > 角色配置 > 全局默认 > Pi 默认。`allowed-models` 是允许显式选择的备选名单，默认模型也允许；越界选择拒绝，不自动遍历备选重试。角色配置模型缺失时原有的父模型回退保持。
- 保留自定义 agentDir 和全部原执行函数、后台通知与结果正文。短常驻委派规则保留等待超时后不轮询、通知非新用户指令、失败任务核对等约束。结果中的旧 `acp_delegate_wait/cancel/agents` 名称分别对应 `op:wait/cancel/agents`。委派入口仅在原代理启用时注册；后续 session_start 刷新底层定义，不重复注册或在调用时增减工具。
- 受限子代理的 ACP 白名单仍为 `compress,acp_context`，原非 ACP 权限不变。`/acp-subagents` 显式运行时使用相同工具名；不会自动改写第三方代理配置。
- 保留内核压缩/召回、nudge、默认摘要规则、host/proxy 拒绝机制和委派通知规则。未移植专用摘要模型、空闲压缩或参考 fork 的其他运行时变更。
- 用户显式配置的 `promptSections` / `delegatePrompt` 仍有优先级，可能增加提示长度。不要给低频旧工具名添加独立扩展；只启用一个 BCP 入口。

### 验证与体积

2026-10-20：`npm run typecheck`、`npm run build` 通过；全量串行回归 `node --import tsx --test --test-concurrency=1 tests/*.test.ts`：1121 tests，1118 passed，3 skipped，0 failed。默认并行运行曾因旧 `delegate-tool.test.ts` 清理共享临时委派文件而导致 fleet 测试失败，因此使用串行全量结果。真实 Pi 0.87.1 加载器验证了当前三个工具、四种上下文操作、代理列表、自定义代理 dry-run、wait/cancel 未知 runId 分支、全部 help 入口与重复 session_start 的工具列表稳定性，全程无模型或浏览器调用。

同一隔离项目、相同代理配置，计入全部 BCP 工具的 schema/说明/prompt 元数据及常驻系统提示，排除基础 Pi 提示和其他扩展：

| 配置 | 工具数 | 字符数 | 约 tokens（ceil(chars/4)） |
| --- | ---: | ---: | ---: |
| 原 fork 0.1.82 | 9 | 36,536 | 9,134 |
| 合并上游 0.1.83，原入口 | 9 | 36,536 | 9,134 |
| 第一阶段：仅上下文 lean | 6 | 13,371 | 3,343 |
| 第二阶段：上下文＋委派 lean | 3 | 3,696 | 924 |
| 当前：补充首次按需发现指引 | 3 | 3,770 | 943 |

当前相较原 fork 字符减少 **89.7%**，相较第一阶段减少 **71.8%**。补充发现指引仅增加 74 个常驻字符（约 19 tokens）；完整名单仍按需返回。这里仍保留全部委派能力，不能直接与删掉委派功能的参考 fork 的宣传数字比较；token 数是估算，非模型 tokenizer 或计费实测。以上只计常驻面，后续调用 agents/help 返回的内容会进入该会话历史。

模型链专项：六个真实代理的 116 组默认/备选模型与思考等级检查中，改造前后 dry-run 逐字一致，真正生成的 `--provider`、`--model`、`--thinking` 参数均匹配；六个越界模型选择均被拒绝。配置和代理文件哈希未变；验证没有启动模型。

### 维护和回退

源码位于 `$PROJECTS_ROOT/billion-context-pi`；Pi 现有本地链接仍使用它。全局 `$HOME/.pi/acp.json` 保留 `autoUpdate:false`、`delegate:true` 和原 `agentDir`，无需再添加一层包装包或开启专用压缩模型。

后续更新先比较上游的工具 schema、返回值和委派白名单逻辑，再运行 typecheck、全部测试、build。`tests/lean.test.ts`、`tests/lean-delegate.test.ts`、`tests/lean-routing.test.ts` 和 `tests/setup-subagent-tools.test.ts` 覆盖外壳、模型链及子代理工具名；`dist` 是构建产物，不手改。入口变更在新会话生效。

本次原始配置、旧构建、检查日志及实际加载测量脚本保存在 `$HOME/.pi/maintenance/bcp-lean-20261020/`。旧分支 `2026-09-29_upstream-v0.1.82` 保留；回退时切回旧分支并构建，或恢复备份构建及旧入口。未提交的 `.gitignore` 修改保持原样。

委派精简前的提交为 `b7c69fd`，对应构建和验证记录另存于 `$HOME/.pi/maintenance/bcp-delegate-lean-20261020/`；可单独回退这一阶段。

发现信息增强前的提交为 `f621ec2`，对应构建、116 组路由检查与配置哈希记录存于 `$HOME/.pi/maintenance/bcp-discovery-20261020/`。

## English

This local fork merges upstream **v0.1.83**, keeps **Pi 0.87.1 / acp-kernel 0.0.98**, and retains configurable delegates. Its Pi entry is `dist/lean.js`; the original factory remains in `dist/index.js`.

Inspired by kunkun9527's MIT-licensed lean fork, it keeps `compress` direct and groups the four low-frequency context tools under `acp_context({op,args})`. Delegation now uses one `acp_delegate` entry with run (default), wait, cancel, agents and help. Common fields stay visible; advanced original parameters go inside args. Help returns each original schema, conflicting/unknown fields are rejected, and execution/results/history remain unchanged. The shortened delegate prompt retains timeout, notification-trust and failed-work rules. Registration follows the original session_start enablement and refreshes captured definitions without duplicating tools. Restricted delegate allowlists and explicit `/acp-subagents` setup keep the context tool names without granting extra non-ACP tools. Explicit user prompt overrides remain authoritative and can increase the footprint.

Dedicated summary models, idle compression and other reference-fork runtime changes are outside this port. The global auto-update-off, delegate-on and agentDir settings are unchanged. Use only one BCP extension entry.

Before the first delegation, query agents when the roster/settings are not already known; reuse the result until configuration changes. Discovery includes public descriptions (single-line frontmatter description, capped at 240 characters), configured models, allowed-models and thinking. It never extracts the private role prompt. Model priority remains call > agent file > role configuration > parent; thinking remains call > agent file > role > global > Pi default. The allowlist supports explicit choices, not automatic failover. All six real agent files remain unchanged; 116 before/after dry runs and actual CLI argument checks agree, and all six out-of-list probes are rejected.

At the same settings, resident BCP metadata and prompt text decrease from **36,536 to 3,770 characters (89.7%)**, or approximately **9,134 to 943 tokens** using chars/4. The preceding context-only lean stage measured 13,371 characters / 3,343 estimated tokens, so the current profile saves another 71.8%. Discovery guidance adds only 74 resident characters over the prior delegate-lean stage. This is not provider billing usage; delegation remains available. On-demand agents/help output is excluded from the resident baseline and enters conversation history when requested.

Validation: typecheck, build, full serial suite (1118 passed, 3 skipped), and actual Pi 0.87.1 loader/operation/dry-run checks. Serial execution avoids the pre-existing shared-temp cleanup race between delegate-tool and fleet tests. No models or browsers were called.

Maintain source and regression tests, then rebuild dist. Configuration/build backups and verification scripts are under `$HOME/.pi/maintenance/bcp-lean-20261020/` and `$HOME/.pi/maintenance/bcp-delegate-lean-20261020/`; the original 0.1.82 branch and pre-delegate-lean commit `b7c69fd` are retained for rollback. New sessions load the changed entry.

Discovery/routing verification and the preceding `f621ec2` build are saved under `$HOME/.pi/maintenance/bcp-discovery-20261020/`.
