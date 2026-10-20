# Local BCP lean profile / 本地 BCP lean 配置

## 中文

此 fork 已合并正式上游 `v0.1.83`（`1cb6340`），保留 `f9757ee` 引入的自定义代理定义。Pi 固定为 **0.87.1**，`acp-kernel` 固定为 **0.0.98**。参考 [kunkun9527/billion-context-pi-lean](https://github.com/kunkun9527/billion-context-pi-lean/tree/d0b3c396739a17f97dd9dac2d7dd690d000f13fc)（`0.2.1`，基于 `0.1.83`）的工具合并及短提示思路，仅移植这个范围。

- Pi 从 `dist/lean.js` 加载；原 `dist/index.js` 工厂仍供程序调用和上游测试使用。`src/lean.ts` 调用本 fork 的工厂，复用现有 `promptSections` 配置机制，没有替换事件钩子。
- `compress` 保持原名、schema 约束、执行与结果，仅精简说明。`decompress`、`search_context`、`acp_status`、`acp_cache` 合并为 `acp_context({op,args})`；冷门参数通过 `{op:"help",args:{tool:"decompress"}}` 查询。派发前按原 schema 校验。
- 召回正文、压缩结果、持久化细节与进度回调原样转发；上游提示中的旧工具名视为 `acp_context` 的操作名，不对历史内容做文本替换。
- 保留 `acp_delegate`、`acp_delegate_wait`、`acp_delegate_cancel`、`acp_delegate_agents`，以及自定义 agentDir、模型/思考级别/工具/超时配置。受限子代理的 ACP 白名单规范为 `compress,acp_context`，原非 ACP 权限不变。`/acp-subagents` 显式运行时使用相同工具名；不会自动改写第三方代理配置。
- 保留内核压缩/召回、nudge、默认摘要规则、host/proxy 拒绝机制和委派通知规则。未移植专用摘要模型、空闲压缩或参考 fork 的其他运行时变更。
- 用户显式配置的 `promptSections` / `delegatePrompt` 仍有优先级，可能增加提示长度。不要给低频旧工具名添加独立扩展；只启用一个 BCP 入口。

### 验证与体积

2026-10-20：`npm run typecheck`、`npm test`、`npm run build` 全部通过；1104 tests，1101 passed，3 skipped。真实 Pi 0.87.1 加载器验证了全部六个工具、四种上下文操作及自定义代理 dry-run，全程无模型或浏览器调用。

同一隔离项目、相同代理配置，计入全部 BCP 工具的 schema/说明/prompt 元数据及常驻系统提示，排除基础 Pi 提示和其他扩展：

| 配置 | 工具数 | 字符数 | 约 tokens（ceil(chars/4)） |
| --- | ---: | ---: | ---: |
| 原 fork 0.1.82 | 9 | 36,536 | 9,134 |
| 合并上游 0.1.83，原入口 | 9 | 36,536 | 9,134 |
| 本 fork 0.1.83，lean 入口 | 6 | 13,371 | 3,343 |

字符减少 **63.4%**。这里保留了 BCP 的四个委派工具，不能直接与删掉委派功能的参考 fork 的宣传数字比较；token 数是估算，非模型 tokenizer 或计费实测。

### 维护和回退

源码位于 `$PROJECTS_ROOT/billion-context-pi`；Pi 现有本地链接仍使用它。全局 `$HOME/.pi/acp.json` 保留 `autoUpdate:false`、`delegate:true` 和原 `agentDir`，无需再添加一层包装包或开启专用压缩模型。

后续更新先比较上游的工具 schema、返回值和委派白名单逻辑，再运行 typecheck、全部测试、build。`tests/lean.test.ts` 和 `tests/setup-subagent-tools.test.ts` 覆盖外壳及子代理工具名；`dist` 是构建产物，不手改。入口变更在新会话生效。

本次原始配置、旧构建、检查日志及实际加载测量脚本保存在 `$HOME/.pi/maintenance/bcp-lean-20261020/`。旧分支 `2026-09-29_upstream-v0.1.82` 保留；回退时切回旧分支并构建，或恢复备份构建及旧入口。未提交的 `.gitignore` 修改保持原样。

## English

This local fork merges upstream **v0.1.83**, keeps **Pi 0.87.1 / acp-kernel 0.0.98**, and retains configurable delegates. Its Pi entry is `dist/lean.js`; the original factory remains in `dist/index.js`.

Inspired by kunkun9527's MIT-licensed lean fork, it keeps `compress` direct and groups the four low-frequency context tools under `acp_context({op,args})`. Help exposes the original schema, validation precedes dispatch, and execution/results/history remain unchanged. Resident ACP rules are shortened through the existing promptSections interface; all delegate tools and notification rules remain. Restricted delegate allowlists and explicit `/acp-subagents` setup use the new context tool names without granting extra non-ACP tools. Explicit user prompt overrides remain authoritative and can increase the footprint.

Dedicated summary models, idle compression and other reference-fork runtime changes are outside this port. The global auto-update-off, delegate-on and agentDir settings are unchanged. Use only one BCP extension entry.

Validation: typecheck, full tests (1101 passed, 3 skipped), build, and actual Pi 0.87.1 loader plus operation/dry-run checks. At the same settings, resident BCP metadata and prompt text decrease from **36,536 to 13,371 characters (63.4%)**, or approximately **9,134 to 3,343 tokens** using chars/4. This is not provider billing usage; delegates are included in both measurements.

Maintain source and regression tests, then rebuild dist. Configuration/build backups and verification scripts are under `$HOME/.pi/maintenance/bcp-lean-20261020/`; the original 0.1.82 branch is retained for rollback. New sessions load the changed entry.
