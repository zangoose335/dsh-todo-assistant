# Stage 2 / Gate 2 验收结论

- **日期**：2026-10-19
- **代码状态**：当前工作区；尚未提交/推送
- **测试基线**：`verify-brief.mjs` 118/118、`verify-domain.mjs` 262/262、`verify-recall.mjs` 35/35、`git diff --check` 通过
- **结论**：**Gate 2 通过（PASS，带已记录限制）**

## 条件对照

| Gate 2 条件 | 状态 | 证据/缺口 |
|---|---|---|
| P0-A1 历史/有效轮次/授权/成本调查 | 部分通过 | ADR 已产出；审批允许/拒绝真实通过；取消 UI 无按钮；unavailable 通道未测 |
| A2 多来源、按需回读、旧卡兼容、失效来源 | 通过（按方案 A） | 多来源/旧卡/失效来源已实现；普通读取不持久记录，结论用 note、空结果用 `no-result`；`duplicatesSkipped` 仅统计当前 surface 跳过 |
| A3 当前可见优先、gap-first、开头 5 轮、停止条件、审批、标记不授权历史 | 部分通过 | first-batch、surface、stop、审批、gap/reason、建卡前 `session:current` 已实现并有自动测试；真实 `session:current` first-batch 审批通过，目录 120 条上限；允许/拒绝已真实通过；取消 UI 无按钮，unavailable 属 DSH fail-closed 契约 |
| A4 sourceIds/where、历史冲突、superseded | 通过（C1 夹具无效） | sourceIds/basis/role 链路已有；C2b 明确替代→superseded、C3 无来源 warning、C4 推断不当事实均通过；C1 夹具与仓库不符，明确替代由 C2b 覆盖 |
| A5 observed 文件校验、文档核对指引 | 通过（含已接受的降级） | 文件 source、purpose、observed/verified、种子核对提醒已实现；没有自动文件存在性检查，按约定交给后续会话核对 |
| A6 历史 10 项 + Token 10 场景 + 累计成本指标 | 通过（带代理限制） | T1→T4 行为/审批实测；T5 的 Gate 1 已通过（见 `docs/GATE1-T5-ACCEPTANCE.md`、`docs/GATE1-RUNTIME-ACCEPTANCE.md`）；T6 由 C2/C2b 覆盖；T7/T10 使用自动代理（目录 cap/不可用反馈）；T8/T9 自动+实测；尚无精确 TokenUsage，只用代理字段 |
| 现有 184 + Gate 1 回归 | 通过（仅确定性） | `verify-brief` 118/118、`verify-domain` 262/262、`verify-gate1` 63/63；T5 语义与真实运行验收已通过；范围限制见 `docs/GATE1-RUNTIME-ACCEPTANCE.md` |
| 文档同步 | 部分通过 | 本报告与测试矩阵已加；PLAN/DESIGN 计数与方案 A 口径已同步；行为探针记录仍未补全 |

## 已记录限制（不阻塞 Gate 2，但不能说成无限制）

- T7（大量无关历史）和 T10（能力受限）使用自动代理验证（manifest 120 条上限、unavailable/fail-closed），没有独立模型行为会话。
- 精确 TokenUsage 不可得，只使用 messages/events/estimatedTokens/batch/duplicatesSkipped 等代理。
- 审批取消/不可用依赖 DSH UI/契约；插件不提供绕过路径。
- C1 夹具与仓库不符（仓库无 SQLite），明确替代由 C2b 覆盖。

## 主要阻塞项

无。A6/A4 均有对应测试或已记录代理；Gate 2 通过但保留上述限制。

> 审批边界不再列为插件阻塞：允许/拒绝已真实通过；取消 UI 无按钮；`unavailable` 由 DSH ToolRuntime 的 fail-closed 契约负责，插件不提供绕过路径。

> append-on-read 不再列为阻塞：方案 A 已确认普通读取不持久记录，只记录结论与显式空结果；原计划中的 append-on-read 被取代。

## 可以确认的进展

- 允许路径：真实审批 + 目录返回通过。
- 拒绝路径：真实审批 `rejected`，未读取通过。
- 同会话压缩隐藏范围：seq 9..1554 共 536 条，目录未标 visible、stop=false；manifest 限制 120 条，避免一次输出约 48.7 万估算 token。
- 跨会话不再误用来源会话的 surface 声称“当前可见”。
- 建卡前 `target:'session:current'` 真实审批通过：first-batch 取开头 5 轮、排除当前轮、目录 120 条上限、未写卡片。
- 文件来源、purpose、observed/verified 与新会话核对提醒已实现。
- 测试与回归通过。

## 下一步

1. 按已记录限制保留 T7/T10 的自动代理，不再伪造独立模型结论。
2. 按用户确认后整理提交/推送。
