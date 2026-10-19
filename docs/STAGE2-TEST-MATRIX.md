# Stage 2 测试与行为探针矩阵

- **日期**：2026-10-19
- **范围**：A2–A6 的历史回读、审批、停止条件、来源与成本代理指标
- **状态**：自动化能覆盖的部分已入库；真实 UI、真实压缩会话和模型行为探针仍未执行
- **重要规则**：行为探针不是自动化测试，不能把“准备执行”写成“已通过”

## 自动测试入口

```text
node scripts/verify-domain.mjs   # 261/261
node scripts/verify-recall.mjs   # 35/35
node scripts/verify-brief.mjs    # 118/118
```

`verify-recall.mjs` 使用 8 个有效人类轮次的 fake log，覆盖开头 5 轮、当前轮排除、合成消息排除、目录/正文、surface 跳过、全可见停止、审批文案和成本代理字段。跨会话读取不使用"来源会话的 surface"来声称当前可见；`surface:false` 有单独断言。同会话隐藏范围实测：seq 9..1554 共 536 条，目录未标 visible、stop=false；manifest 限制 120 条，避免一次输出全部 536 条。

## 10 个历史功能场景

| # | 场景 | 覆盖方式 | 状态 |
|---|---|---|---|
| 1 | 读取当前捕获轮次（origin） | `verify-recall` origin manifest/body；`verify-domain` recall | 自动通过 |
| 2 | 读取建卡前的历史轮次 | `target:'session:current'` 已实现；`verify-domain` 覆盖 manifest、first-batch、id 冲突、缺 target；真实审批 first-batch 通过 | 自动 + 真实验证通过 |
| 3 | 一张卡关联多个历史来源 | `verify-domain` 多 source、sourceId、文件 source | 自动通过 |
| 4 | 第一批取开头最早 5 个有效轮次 | `verify-recall` 8 轮 fake log | 自动通过 |
| 5 | 第一批足够时停止 | `verify-recall` 全可见停止 + short batch | 自动通过 |
| 6 | 第一批不足时说明缺口 | `verify-recall` short batch；模型说明缺口的探针未执行 | 部分自动 |
| 7 | 未获 allowed-once 不读额外历史；索引/正文审批 | approval 纯函数和 fake 结果测试；真实 UI 已测允许（allowed-once）与拒绝（rejected）；UI 无取消按钮 | 允许/拒绝通过；取消 UI 不可用 |
| 8 | 无效/缺失/不可用来源有明确反馈 | `verify-recall` 缺 session、文件 source；`verify-domain` 未知 source | 自动通过 |
| 9 | 文档路径保存并在后续核对 | `verify-domain` file source、purpose、verified；新会话种子文本仅代码审查 | 自动数据部分通过；种子/真实核对探针待做 |
| 10 | 不把无关主任务上下文整体复制进卡片 | `verify-recall` 只返回指定 slice；来源只存指针；body 跳过可见 | 自动通过 |

## 10 个 Token 效率场景

| # | 场景 | 覆盖方式 | 状态 |
|---|---|---|---|
| 1 | 当前可见已足够 → 不调用 todo_recall | prompt/行为探针；无自动模型探针 | **待执行行为探针** |
| 2 | 路径可延后 → 不做不必要检索 | prompt/行为探针；无自动模型探针 | **待执行行为探针** |
| 3 | 重要缺口 → 审批后读最小历史 | approval 纯函数 + slice 限制；真实审批/模型探针未执行 | 部分自动 |
| 4 | 第一批足够 → 不继续读取 | `verify-recall` 全可见 stop / short batch | 自动通过 |
| 5 | 第一批不足 → 说明剩余缺口再授权 | short batch 自动；模型说明/二次审批探针未执行 | 部分自动 |
| 6 | 历史与当前冲突 → 识别变更/询问 | T2 brief basis 与 `superseded` 约束测试；行为探针未执行 | 部分自动 |
| 7 | 大量无关历史 → 不整体注入 | `verify-recall` 只取请求 slice；来源不存正文；manifest 限制 120 条，超出时提示缩小范围 | 自动通过 |
| 8 | 已提取信息 → 避免重复摘要 | 按方案 A：普通读取不持久记录，结论用 note、空结果用 `no-result`；`duplicatesSkipped` 只覆盖 surface 跳过 | 按方案 A 已处理 |
| 9 | 当前可见早期信息 → 不重复读 | `verify-recall` body 跳过 visible；全可见 stop | 自动通过 |
| 10 | 能力受限（无轮次/无审批/无日志）→ 不伪造 | `verify-recall` 缺 session/surface；同会话隐藏范围实测未误报 visible；跨会话 surface 不参与判断 | 自动 + 真实验证通过 |

## 累计成本代理指标

自动化测试可提供：

- `messages`：本次返回的消息数；
- `events`：本次读取涉及的原始事件数；
- `estimatedTokens`：估算值，不是精确账单；
- `batch`：0 单次 / 1 first-batch；
- `duplicatesSkipped`：当前 surface 已可见而跳过的数量；
- `surfaceKnown` / `surfaceVisible`：是否知道当前 surface、可见多少条。

仍不能自动提供：

- 不必要读取次数（需要模型行为探针）；
- `index` 与 `body` 的真实占比（目前只有调用记录，不是持久账本）；
- 是否遗漏关键约束（需要行为评估）；
- 简报是否足够避免后续复研（需要行为评估）；
- 精确 TokenUsage（不伪造）。

## 行为探针协议

每条探针必须记录：

1. 场景编号和问题；
2. 使用的卡片、会话和 source 范围；
3. 模型实际调用了什么（有无 `todo_recall`、有没有带 gap/reason、有没有继续读）；
4. 审批结果（allowed-once / rejected / cancelled / unavailable）；
5. 预期与实际差异；
6. 是否触发额外读取或重复内容。

不能把“模型应该会”写成“已验证”。真实 UI 审批和压缩会话探针未完成前，A6 不能宣称全部通过。

## 明确未完成

- 真实 web 审批：允许、拒绝已实测；UI 没有取消按钮；`unavailable` 属 DSH fail-closed 契约，不是插件缺口。
- 真实压缩会话：同会话隐藏范围（seq 9..1554）已实测；其他压缩样本未测。
- 普通读取不持久记录（方案 A 已确认）；跨会话不会自动知道“这段读过”，只会保留显式结论和空结果。`duplicatesSkipped` 只表示当前 surface 已可见而跳过。
- 10 个 Token 场景的模型行为探针：未执行；当前只有代理字段和自动断言。
- 精确 TokenUsage 对比：当前不承诺，只用估算/代理指标。
- A4 历史冲突/被替代的行为探针：未执行；只有 T2 brief 校验和部分数据测试。
