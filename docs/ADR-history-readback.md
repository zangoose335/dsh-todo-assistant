# ADR：历史回读、有效轮次、审批与 Token 指标（P0-A1）

- **状态**：提议（代码/类型事实已核对；真实审批 UI 与 `readSurface` 的 persisted/compacted 探针仍待补）
- **日期**：2026-10-19
- **DSH 版本**：0.2.0-rc.2
- **范围**：Stage 2 A2/A3 的前置调查；不改变 Stage 1 行为
- **证据**：`dsh-session-query`、`dsh-tools`、`dsh-user-approval`、`tokenMeter` 的类型声明；当前会话原始日志探针；现有 `recall.js` / `host.js`

## 1. 能读什么

- `ctx.sessionQuery.readSession(sessionId)` 返回 `SessionLogSnapshot`：`session`、`inheritedEventCount`、`events`。类型注释明确为“complete logical session log”，并经过 replay validation；这是 A2 读取任意历史来源的底层 API。
- `ctx.sessionQuery.readSurface(sessionId)` 返回 `SessionSurfaceSnapshot`：`session`、`inheritedEventCount`、`capturedThroughSeq`、`events`。`events` 是“current surface events in model-history order”，可用于判断当前模型仍能看到哪些 seq。
- 当前 `recall.js` 只使用 `readSession`，并且只按卡片 `origin.seqRange` 过滤 `user/message`、`assistant/message`、`tool/result`、`developer/message`；没有任意来源、没有 surface 比对、没有多来源。
- 原始日志探针（当前工作区的一个长会话）：5081 条日志、46 个 `turn/start`、47 条人类 `user/message`、54 条 `compaction/prune`；第一条人类消息 seq 12 在最后一次 compaction（seq 5042）之后仍存在于原始日志。**原始日志保留早期事件，不等于当前 surface 仍可见。**

## 2. 有效轮次怎么算

采用 PLAN §2.3.2 的定义：

- `turn/start` 的 `data.turn` 是轮次括号；
- 一条人类 `user/message` 且 `source.kind === 'user'`、文本非空，才算该轮有效；
- 合成注入、工具调用/结果、assistant 消息不单独计数；
- 同一轮多条人类发言算一轮；
- 当前轮排除；
- 子会话按卡片 `origin.sessionId` 读取，不默认回父会话；
- 不足 5 轮取实际值，不伪造；
- 无法可靠定位时标 `boundary:'approximate'`。

探针事实：该长会话 47 条人类 `user/message` 中，`data.turn` 出现次数为 0；当前 `recall.js` 已通过遍历 `turn/start` 维护当前 turn，再给消息归属，这是可复用的实现基础。

## 3. 开头不足 5 轮怎么办

- 按 turn 升序取“开头最早的有效轮次”，不足 5 轮就返回实际数量。
- 不是“最近 5 轮”，不是“最近 5 条消息/事件/工具调用”。
- 第一批不是必选项；当前 surface 已足够时可以不读。
- 没有 origin 的手工卡明确返回 `unavailable`，不伪造 first batch。

## 4. 当前轮、子会话怎么排除

- 当前轮：以当前 turn 为上界，排除该 turn 的 `user/message` 及之后事件。
- 子会话：卡片 `origin.sessionId` 就是读取目标；`origin.rootSessionId` 只用于 UI 分组/编号，不改变回读目标。
- 建卡前需要历史时用 `session:current` 目标；建卡后用卡片 id 目标；不先建不完整临时卡。

## 5. 压缩后还能不能定位

- `readSession` 返回的是完整原始日志（replay validated），不是当前 surface；因此早期轮次仍可按 seq 定位。
- `readSurface` 提供当前模型 surface 的事件列表；可以用其 seq 判断“这段历史是否还在可见 surface 中”。
- 如果 `readSurface` 不可用或失败，不能假设开头仍可见；按 PLAN 的保守规则，由 AI 先检查当前可见上下文，不自动读取。

## 6. 如何判断开头是否仍可见

- 优先调用 `readSurface(sessionId)`，取 `events[].seq`（surface event 带 seq），与待读来源/开头批次的 seq 比较：
  - 已在 surface 中：不重复读取，只提示“当前可见”；
  - 不在 surface 中：才考虑按需回读。
- `readSurface` 的 persisted/compacted 行为仍需真实探针确认；在确认前，失败即回退到“不自动读、先问开发者”。
- 不能仅凭原始日志存在就声称内容仍可见。

## 7. 审批服务在 web profile 是否可用

- `tools/pre-execute` 支持返回 `{ kind:'ask', reason, displayReason }`。`ToolRuntime` 的 `serviceAsk` 通过 `ctx.get('approval')` 取得审批服务；只有 `allowed-once` 放行，`rejected`/`cancelled`/`unavailable` 都拒绝。
- `dsh-base` 的 `approval` 行挂载 `@deepseek-ai/dsh-user-approval`；`dsh-web-app` 有 `ui-approval`。因此 web profile 具备审批服务与 UI 的组合。
- `ApprovalService.request` 要求 open turn；`tools/pre-execute` 在轮次内执行，满足该前提。
- 代码事实已确认；真实 web 点击批准/拒绝的探针仍未执行。

## 8. 一次批准覆盖什么

- 一次 `ask` 只覆盖该次工具调用；下一次调用重新询问。
- `reason`/`displayReason` 可展示目标会话、轮次/seq 范围、用途、预计规模。
- 不使用 `approved:true` 参数；模型自填布尔值不构成授权。

## 9. 如何 fail closed

- 没有 approval 服务 → 拒绝；
- 没有 agent/无 open turn → 拒绝；
- `rejected`/`cancelled`/`unavailable` → 拒绝；
- 审批服务异常 → 拒绝；
- 不提供“审批不可用时只读 index”的降级路径；不静默读取。

## 10. Token 指标

- `tokenMeter.measure(session)` 返回当前 surface 的 `surfaceTokens`/`totalTokens` 与逐节点 `{seq, tokens, heuristicTokens}`；这是当前 surface 的路由计价/启发式，不是历史正文的精确账单。
- `tokenMeter.estimateMessage(message)` 可对单条消息做启发式估算；现有 `host.js` 已将可选的 `estimateMessage` 注入 `recall.js`。
- 历史 assistant 消息可能带 `usage`，但不能保证所有历史消息都有可复用的实际 token。
- A2/A3 的 `stats` 应至少包含：messages、events、estimatedTokens、batch、duplicatesSkipped，并明确 estimated 而非精确账单；不能编造精确 token。

## 决策

1. A2 使用 `readSession` 读原始来源；`readSurface` 只用于可见性去重，不把 surface 当历史正文来源。
2. sources 只存指针（sessionId/kind/range/where），不存正文。
3. A3 用 `tools/pre-execute` 的 `ask` 做审批；只认 `allowed-once`；不引入 `approved` 布尔值；一次调用一次审批。
4. 有效轮次与 first batch 按本 ADR 第 2/3 节实现；不足/不可定位时返回实际值或 unavailable。
5. Token 统计使用实际可得值 + 启发式估算，UI/工具输出标明 estimated；代理指标与 PLAN §2.8.5 一致。

## 未完成/待验证

- 真实 web 审批：批准、拒绝、取消、审批服务不可用四种路径的审计日志与 UI 行为。
- `readSurface` 在 persisted/compacted session 上的事件覆盖与 seq 语义。
- 历史 assistant `usage` 的可用性与一致性。
- 以上结论绑定 DSH 0.2.0-rc.2；升级需复核。

## 下一步

1. 按本 ADR 落地 A2：`sourceRef` schema、`sources`、`addSource`/`findSource`、`recall` 的多来源/首批/统计、`todo_recall` 参数与 `todo_add`/`todo_note`/`todo_read` 的来源投影。
2. 落地 A3：`tools/pre-execute` 审批、有效轮次、first batch、surface 去重、停止条件。
3. 用 `scripts/verify-domain.mjs` 增加多来源、审批（fake）、有效轮次、surface 去重、Token 代理指标与回归测试。
