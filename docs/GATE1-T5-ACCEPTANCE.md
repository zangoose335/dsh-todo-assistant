# Gate 1 / T5 十场景质量验收记录

- **日期**：2026-10-19
- **代码基线**：`2839fe9`（本验收工作未提交；`git status` 以实际工作区为准）
- **工具描述**：修正前 3641 字符，sha256 前缀 `66ca102c`；2026-10-19 按新 blocking 语义修改后为 6129 字符，sha256 前缀 `8fa6fbad`。表 B 保留修正前结果；修正后复跑见表 B2。
- **模型**：`deepseek-flash`（会话默认）
- **判定口径**：开发者 2026-10-19 确认采用**严格重判**——语义质量未验证前，不把 Gate 1 描述为 PASS。

## 结论

> **2026-10-19 后续修复**：`todo_add` 已统一 blocking 语义（可能影响实现/验收即 blocking，即使卡片可创建），允许在开发者明确要求时创建带 blocking 缺口的卡片，并限制 nextAction 绕过阻塞。S3/S4/S5/S6/S9 复跑通过；Gate 1 仍因真实 UI/recall/旧插件/存储未验收而未通过。

**Gate 1 未通过。**

- **确定性验收**：§8.0 的 S1–S10 全部通过（39/39）；加上契约/持久化断言共 63/63（`node scripts/verify-gate1.mjs`）。
- **语义探针**：修正前为 5 通过 / 4 部分 / 1 未定；修正后 S3/S4/S5/S6/S9 复跑通过，T5 语义探针 10/10 通过。S9 仍是隔离探针中的“先问”，真实 duplicate 门禁未验证。
- **场景 10**：确定性拒绝通过；隔离探针选择先问开发者、未编造卡片。但真实运行时没有复测。
- **旧版本兼容**：真实旧代码（`be8ebf4`）探针 11/11；仍不是“旧插件在真实 UI 中运行”。

因此，`PLAN.md` 之前写的“Gate 1 PASS”已按本次结果纠正为**未通过**。这是按 §6 的严格条件判定，不是把已完成的确定性工作说成没做。

## 证据入口

```text
node scripts/verify-gate1.mjs           # 63/63；S1-S10 39 项 + 契约/持久化 24 项
node scripts/verify-gate1-probes.mjs    # 回放 docs/GATE1-T5-PROBES.json（诊断，不判 PASS）
node scripts/verify-legacy.mjs          # 11/11；真实旧代码 be8ebf4 + 备份恢复
node scripts/verify-brief.mjs           # 118/118
node scripts/verify-domain.mjs          # 262/262
node scripts/verify-recall.mjs          # 35/35
```

语义探针的原始输出保存在 `docs/GATE1-T5-PROBES.json`。探针明确禁止调用工具，因此：

- `wouldCallRecall` 是模型自述，不是工具调用轨迹；
- S9 没有真正触发 `todo_add` 的 duplicate 门禁；
- 这不是真实 DSH UI 运行。

## 表 A：确定性验收（S1–S10）

| # | 场景 | 本脚本验证的系统行为 | 结果 |
|---|---|---|---|
| 1 | 当前上下文充分 | 完整 brief 落库、读取一致、`core.nextStep` 同步、无来源-only 警告 | PASS 5/5 |
| 2 | 需求完整但无文件 | 空 `touchedFiles` 仍可建卡、约束保留、leads 为空 | PASS 4/4 |
| 3 | 用户已确认约束 | `decided`/`requirement` 约束原样保留，不被降级为推断 | PASS 2/2 |
| 4 | 推断与未确认假设 | `inferred`/`unknown` 保留，可信度警告出现，不被写成决定 | PASS 3/3 |
| 5 | 矛盾的决定 | 两条冲突决定都保留，`blocking` 问题随卡持久化，不静默选边 | PASS 3/3 |
| 6 | 缺少关键信息 | `blocking` 问题持久化，不凭空生成 confirmed/constraints/leads | PASS 2/2 |
| 7 | 简单任务 | 最小 brief 通过、可选数组为空、无质量警告、不被堆长 | PASS 4/4 |
| 8 | 复杂任务 | 各段保留、关键约束不丢、不超硬上限 | PASS 3/3 |
| 9 | 已有相似待办 | 同文件+同目标命中、不同目标不误拦、`forceCreate` 建卡、`todo_note` 合并不建第二张 | PASS 5/5 |
| 10 | 只有来源/路径（必须失败） | 路径-only 与 leads-only 均拒绝且不落库；`forceCreate` 不能绕过；旧式空路径 `nextStep` 仍兼容 | PASS 8/8 |

补充的契约与持久化断言：`nextStep`/`brief.nextAction` 只给其一的四种组合、冲突 warning、手工 API、`applyPatch`、读取投影、旧 fixture、close/reopen，共 24/24（CONTRACT 14/14，PERSIST 10/10）。

> 这张表证明的是“系统对给定简报的判定正确”，**不证明模型会写出这样的简报**。不能拿它代替语义验收。

## 表 B：隔离模型探针（S1–S10）

探针协议：每个场景给子代理一段当前可见上下文，要求它只输出 `todo_add` 参数或提问，不允许调用工具、不允许读历史。结果记录在 `docs/GATE1-T5-PROBES.json`，再由 `verify-gate1-probes.mjs` 回放。

| # | decision | 是否自述会 recall | 关键发现 | 判定 |
|---|---|---|---|---|
| 1 | create | 否 | goal/constraint/nextAction 齐全；`nextStep` 与 `brief.nextAction` 措辞略有差异，系统按契约以 brief 为准并 warning | 通过 |
| 2 | create | 否 | 无文件路径仍能给出可执行简报；约束写入 constraints | 通过 |
| 3 | create | 否 | 两条已定约束写进了 `confirmed`（basis `decided`），`constraints` 为空；读取时出现“2 条无 sourceIds”警告 | 部分通过：信息在，字段语义错 |
| 4 | create | 否 | inferred/unknown 标注正确；但额外塞入一条 basis 为 `verified` 的“不能当结论”约束，绕过了可信度检查 | 部分通过 |
| 5 | create | 否 | 冲突被写进 openQuestion，没有选边；但 impact 标成 `non-blocking`，且方案 A/B 两条决定没有写入 constraints | 部分通过：指出冲突，但严重性低估 |
| 6 | create | 否 | 缺反馈形式/触发条件被写进 openQuestions，没有编造；但两条都是 `non-blocking`，也没有主动问开发者 | 部分通过 |
| 7 | create | 否 | 只有 goal + nextAction，无冗余字段，无 recall | 通过 |
| 8 | create | 否 | goal/why/3 constraints/2 leads/1 open 齐全；leads 的 basis 用 `requirement` 不准确 | 通过（附注） |
| 9 | none | 否 | 识别出已有 #4.29，选择直接追加 note、未先问开发者；探针禁止调用工具，duplicate 门禁未被触发 | 未定：需要真实运行时复测 |
| 10 | ask | 否 | 缺文件/目标/下一步时先问开发者，未编造，未自行读历史 | 通过 |

语义探针发现的具体问题（不是确定性测试失败）：

1. **constraints 与 confirmed 混用**（S3）：已定约束被放进 `confirmed`。信息没丢，但违反了“约束应进 constraints”的字段语义。
2. **impact 低估**（S5、S6）：会阻塞选型/实现的缺口被标成 `non-blocking`；系统不会拦截，卡片看起来可以立即开工。
3. **额外字段/错误 basis**（S4、S8）：S4 塞入一条 `verified` 的元约束；S8 把文件线索标成 `requirement`。
4. **重复合并未先确认**（S9）：模型直接选择追加 note；由于探针禁止工具调用，不能据此断言真实运行也会跳过 duplicate 提示。

这些是修正前的问题；2026-10-19 已按新 blocking 语义修改 `todo_add` 并复跑，结果见表 B2。当前代码没有为了通过测试而改确定性断言。

## 表 B2：修正后复跑（2026-10-19）

描述：6129 字符，sha256 前缀 `8fa6fbad`。使用与表 B 相同的隔离输入。

| # | decision | 复跑结果 | 判定 |
|---|---|---|---|
| S3 | create | 两条已定约束进入 `constraints`，`confirmed` 为空 | 通过 |
| S4 | create | 推断/未知保留，没有多余的 `verified` 元约束 | 通过 |
| S5 | create | openQuestion 标 `blocking`，未静默选择 A/B；nextAction 先确认 | 通过 |
| S6 | create | 反馈形式与触发条件都标 `blocking`，nextAction 先确认，不直接实现 | 通过 |
| S9 | ask | 先问“追加到 #4.29 还是新建”；未直接合并 | 通过（真实 duplicate 门禁仍未验证） |

结论：S3/S4/S5/S6/S9 的语义缺口已修复；T5 的隔离语义探针现在 10/10 通过。Gate 1 仍未通过，剩余阻塞项是真实运行时、旧插件 UI 和真实存储演练。

## 表 C：旧版本与降级

| 验证 | 方式 | 结果 |
|---|---|---|
| version-1 fixture 打开 | `verify-gate1` / `verify-brief` | 通过；旧卡派生 brief，不写回 |
| 新 brief 持久化 | 临时 JSON 后端，close/reopen | 通过；文件版本仍为 1 |
| 真实旧代码读取新数据 | `be8ebf4`（引入 brief 前的最后一个提交）的真实 `domain.js` | 旧代码能打开；读取时 strip `brief` 和 `sources` |
| 真实旧代码写回 | 旧代码 `table.put` 一条新卡 | `brief`、`sources` **永久丢失**；其他字段保留 |
| 备份恢复 | 写回前复制文件，旧代码写回后恢复 | 当前代码重新打开后 brief/sources 恢复 |
| 旧插件在真实 UI 中运行 | 未执行 | **未验证** |
| 任意已发布旧版本 | 未执行 | **未验证** |
| 真实 `~/.dsh` 存储的备份/恢复演练 | 未执行（探针使用临时副本） | **未验证** |

结论：降级风险不止 `brief`，`sources` 也会被旧 schema 丢弃。升级前必须备份；旧版本只用于只读诊断，不要写回。

## 明确未验证

1. 真实 DSH UI 中的十场景执行（本次是隔离探针 + 确定性回放）。
2. 真实工具调用轨迹：模型是否真的没有调用 `todo_recall`（探针只有自述）。
3. S9 在真实 duplicate 门禁之后是否先询问开发者（隔离探针已先问，但未经过真实门禁）。
4. 旧的已发布插件在真实 UI 中读取/写回新数据。
5. 真实用户存储的备份、恢复、升级、降级、迁移、回滚演练。
6. “简报是否足以指导后续开发”的人工语义判断（本次只检查了结构、basis、字段语义和明显缺失）。
7. 场景 10 的真实模型复测：隔离探针选择先问；确定性拒绝通过；真实运行时未复测。

## Gate 1 判定

按 `docs/PLAN.md` §6：

- T1–T4：代码与确定性测试已实现；T4 的真实旧代码探针已补，旧插件 UI 未验证。
- T5：§8.0 的确定性部分全部通过；修正后隔离语义探针 10/10 通过。
- 场景 10：确定性拒绝通过；隔离探针先问；真实模型运行时未复测。
- 现有测试不回归：`verify-brief 118/118`、`verify-domain 262/262`、`verify-recall 35/35`。

**结论：Gate 1 未通过。** 语义缺口已修复；剩余阻塞项是真实 DSH UI、真实 `todo_recall` 轨迹、旧插件真实 UI、真实存储演练和场景 10 真实复测，不是确定性 schema 或字段语义问题。
