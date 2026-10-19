# 待办助理 (todo-assistant) — 设计文档

> 状态：§10 第 1、2 点已验证；M1–M7 已实现（见 §10 结论与 §12）
> 目标 profile：`web`
> 源码位置：本仓库根目录（`todo-assistant/`）
> 文档版本：v2（2026-10，补验证结论）

---

## 0. 命名与定位

**待办助理**是一个 DSH 插件。它解决的不是"列待办"，而是**旁支任务的上下文搬运**。

DSH 里已经有两个容易混淆的东西，必须先划清界限：

| 名字 | 是什么 | 与本插件的关系 |
|---|---|---|
| `todo_write`（DSH 自带工具） | 本轮任务的进度条。会话事件 `todo/write`，`turn/start` 时清空 | **完全不同**。它是"这一轮我打算怎么做"，会随轮次消失 |
| `goal`（`create_goal`） | 当前会话的持久化目标 + 自动续跑 | **不同**。它绑定单个会话，是"把这件事做完" |
| **待办助理** | 跨会话的旁支任务工作台，带现场快照 | 本文档描述的对象 |

因此包名 / 目录名用 `todo-assistant`，显示名「待办助理」，避免和 `todo_write` 撞概念。

---

## 1. 原始场景（需求来源）

开发者在会话里执行主任务时，会遇到三种需要"记下来但先不做"的情况：

1. 调查代码时发现一个与当前任务无关的既存 bug
2. 某个 bug 涉及范围过大，需要主任务结束后单独处理
3. 执行任务时冒出新的功能想法

典型对话：

```
轮次 1: 丢开发文件，提出主任务
轮次 2: 说明设计理念
轮次 3: 踩坑，要求修改；同时在调查中发现了另一个无关的既存 bug
轮次 4: 要求修复主任务的 bug，同时要求把无关 bug 加进待办
轮次 5: 实机验证，想到一个新功能
轮次 6: 交付新功能；若新功能可能与待办有关，补充其相关信息（只加索引即可）
```

痛点按重要性排序：

1. **重复调查烧 token** —— 之后开新会话处理时，AI 得把当初的调研重做一遍
2. **重复描述耗精力** —— 开发者要重新讲一遍问题
3. **主任务被污染** —— 把无关的上下文塞进主任务，既费 token 又诱导模型跑偏

---

## 2. 三条设计不变量

任何功能如果违反其中一条，就不做。

1. **捕获免费，读取付费**
   写卡不进上下文；读卡才进。所有成本讨论都收敛在"读回"这一个边界上。

2. **判断的粒度由人划定，不由 AI 猜**
   勾选哪几段、要不要回读被压缩的历史，由开发者点击决定。

3. **AI 只做它此刻唯一能做的事**
   有上下文时负责"筛选"；没有上下文时负责"问人"。

---

## 3. 关键决策记录（含理由）

### 3.1 为什么不把完整上文存进待办

这是最初的两个候选方案之一（全文 vs AI 摘要）。结论：**都不用，改用三层结构**。

理由（基于 DeepSeek 官方前缀缓存规则）：

- 缓存是磁盘前缀缓存，命中要求从第一个 token 起完整匹配一个已持久化的 cache prefix unit
- unit 在四处产生：用户输入结束处、模型输出结束处、多请求公共前缀、长文本固定 token 间隔
- **新会话的 system prompt 与原会话不同**（DSH 会拼入运行环境：cwd、日期、审批策略等），所以粘贴的旧上文第一次一定全 miss，按未命中输入计价
- 之后该会话内继续对话才会被缓存覆盖

所以"全文方案"的真实成本是：

| | 第一次 | 后续每步 | 上下文窗口 | 行为风险 |
|---|---|---|---|---|
| 全文入上下文 | 全价 | 命中价 | 永久占用 | 高（旧任务细节诱导跑偏） |
| 摘要卡 | 很便宜 | 很便宜 | 小 | 低 |

即：**缓存救不了第一次的全价，更救不了窗口占用和语义污染。**

补充事实：`TokenUsage` 里有 `cacheReadTokens`，这件事可以实测，不需要估。

### 3.2 三层结构

| 层 | 内容 | 何时进上下文 |
|---|---|---|
| **L0 索引** | id / 标题 / 状态 / 一句话 | 命中提醒时临时注入，或 AI 主动 `todo_list` |
| **L1 卡片** | 现象、原因、下一步、触及文件、符号 | AI `todo_read` 时 |
| **L2 原文** | 原会话的事件区间指针 + spill 文件路径 | 开发者确认后 `todo_recall` 按段读取 |

L2 永远不主动加载。

### 3.3 捕获要深，检测要浅

- **捕获深**：一次性操作，发生在"开发者同意加"那一刻。回扫整段会话，筛出与旁支相关的部分
- **检测浅**：每轮一次，只看最近一两轮，只求"疑似有关"。误报代价是一行提示，漏报可事后补

### 3.4 写卡者：主 Agent，也允许子会话

最初的理由：筛出轮 1、2 里对旁支有用的东西，要求写卡者手里正拿着那几轮原文。主 Agent 此刻全在上下文里；任何独立总结器都要重读。

**现在的决定：子会话也允许写卡。** 理由：子会话常常比主会话更贴近现场（它正在改那个文件），
拦着反而丢掉一手信息。代价与处理：

- 编号不另起：子会话的卡按 `origin.rootSessionId` 归到**根会话**的 major（§4 的 `x.y`）；
- 主会话拿到的卡片内容可能来自子会话的视角，`origin` 里保留了子会话 id，必要时可 `todo_recall` 回读（先问）。

**因此捕获的边际成本 = 一次工具调用的输出，零额外模型调用。**

### 3.5 相关性检测范围：只判本会话新建的待办

老待办属于别的会话、别的现场，与当前轮无关，不参与判断。这一条把问题从"检索全部待办"降级为"盯着刚存的卡片"。

### 3.6 AI 不主动添加待办

流程必须是：AI 发现 → 在回复里报告（是什么、影响面）→ 询问是否要加 → 开发者同意 → 才调 `todo_add`。

技术上靠工具描述里的硬约束，不加额外机制。兜底：AI 有时会忘记问，所以 UI 上提供「记为待办」按钮供开发者随时手动触发。

### 3.7 压缩内容的回读必须先问

`sessionQuery.readEvent` 成本不低：要把原会话那段完整读出来，而且读进来后**永久留在上下文**、被后续每一步重复计费。它省的是"回忆"，不是 token。

且越早的内容相关性越低，真正重要的内容开发者自己知道。

所以：上下文里没有 → **不静默回读**，先问开发者。开发者同意后，**先给目录再给正文**（见 `todo_recall`）。

### 3.8 卡片增量追加，不重写

轮 6 补充信息时，不让 AI 重写整张卡（重写必丢细节，且看不出改了啥）。改为追加一条带来源的 note。

### 3.9 补充 note 不问开发者

只是记录，不打断主任务。UI 上以角标提示。

### 3.10 代码坐标记三档

| 档 | 存什么 | 稳定性 | 说明 |
|---|---|---|---|
| 脏指纹 | `commit` + `branch` | 极高 | 方法改名了 `git show <commit>` 仍能还原；`git blame` 能把旧符号追到新位置 |
| 符号 | `File#symbol` | 中 | 重构就失效，但读代码时最自然 |
| 行号 | `file:line` | 低 | 只当"大概在附近"的提示，不作权威 |

commit 由 host 侧写卡时取（`git rev-parse HEAD`），不需要 AI 出力。

**如果连符号都找不到了，说明代码已大改，此时应当重新调查，而不是信任卡片。**

### 3.11 会话与待办可绑定，两种方式

在卡片上点「处理」：

- **新开会话** —— 卡片 L1 作为开局内容注入，标记该会话在处理 `#id`
- **插入当前会话** —— 主任务已收尾时更省 token。只发一句"现在切到 #6"，具体补什么由 AI 从卡片里挑（通常是"下一步"和"触及文件"），其余靠上下文里已有的东西

由开发者选择，插件不替它决定。

### 3.12 待办归属：按工作区 + 全局收件箱

一个 bug 通常属于某个仓库。但"读某篇文档时想到的东西"可能跨仓库，所以留一个全局收件箱。

---

## 4. 数据模型

存储用 `ctx.storageDomain`（全局、跨会话、跨重启），单表 `todos`，按 `workspacePath` 过滤。

```ts
/** How one brief item is known; never promote inferred/unknown to verified. */
type BriefBasis = 'requirement' | 'decided' | 'verified' | 'inferred' | 'unknown' | 'superseded'

interface BriefItem {
  text: string
  basis: BriefBasis
  sourceIds?: string[]          // optional existing SourceRef ids; never auto-read history
  impact?: 'blocking' | 'non-blocking'
}

/** The card's primary content; paths and sources are fallback leads. */
interface TaskBrief {
  goal: string
  why?: string
  confirmed?: BriefItem[]       // confirmed facts/decisions; default []
  constraints?: BriefItem[]     // must-not-violate constraints
  leads?: BriefItem[]           // files/symbols/docs; auxiliary only
  nextAction: string            // canonical next step
  openQuestions?: BriefItem[]   // unresolved gaps; may block execution
}

interface TodoItem {
  id: string                  // "td_x7k2"（内部主键）
  major?: number              // "3"（第几个会话）
  minor?: number              // "2"（该会话内第几张）
  number?: number             // 已废弃，仅迁移时读取
  workspace: string           // cwd 的规范化路径，或 "inbox"
  title: string               // 开发者可改
  status: 'open' | 'doing' | 'done' | 'dropped'
  kind: 'defect' | 'idea'
  createdAt: number
  updatedAt: number

  origin: {
    sessionId: string
    turn: number              // 添加时的轮次
    seqRange: [number, number] // 相关事件区间 —— 指针
    cwd: string
    at: number
  }

  request?: {                 // 开发者原话（手打要求记待办时由 host 原样抓取）
    text: string              // 逐字保留，不总结、不改写
    turn: number
    at: number
    messageId?: string
    truncated?: boolean       // 超过 8000 字时截断
  }

  code: {
    commit: string            // 写卡时的 git HEAD
    branch: string
    symbols: Array<{ file: string; symbol?: string; line?: number }>
  }
  touchedFiles: string[]      // 规则匹配用，AI 填；写入时归一化成工作区相对路径

  core: {                     // 兼容主区；旧客户端仍读取
    symptom?: string          // 现象（缺陷型）
    cause?: string            // 已定位的原因
    nextStep: string          // 兼容镜像；规范来源是 brief.nextAction
    intent?: string           // 意图（想法型）
  }

  /** 任务简报；旧卡缺省时由 core/mustRead/park/touchedFiles 只读派生。 */
  brief?: TaskBrief

  mustRead: EvidenceRef[]     // 必读参考，≤3 条，每条 ≤200 字
  park: ParkedRef[]           // 备查区：标记存在，默认不读
  notes: Note[]               // 增量追加，永不重写
}

/** 按工作区保存的通用规则（另一张表，key = 工作区路径）。 */
interface WorkspaceRules {
  workspace: string
  text: string
  updatedAt: number
}

interface EvidenceRef {
  label: string               // 一句话
  text: string                // ≤200 字
  where?: { sessionId?: string; seqRange?: [number, number]; file?: string }
}

interface ParkedRef {
  id: string
  label: string               // ≤30 字：这是什么
  why: string                 // ≤60 字：可能与什么有关
  where: { sessionId?: string; seqRange?: [number, number]; file?: string; offset?: number }
  // 恒为按需加载，无 autoLoad 字段
}

interface Note {
  at: number
  fromSession: string
  turn: number
  kind: 'supplement' | 'evidence' | 'status' | 'no-result'
  text: string                // ≤300 字
}
```

### 4.1 TaskBrief 持久化与兼容策略

- `brief` 是 optional 字段；当前 `DOMAIN_VERSION` 仍为 `1`，没有新增必填字段或表。
- `brief.nextAction` 是唯一规范来源；`core.nextStep` 是为旧客户端保留的兼容镜像。正常写入路径必须同步二者。
- 旧卡没有 `brief` 时，`projectFull`/`todo_read` 从 `core.symptom`、`core.intent`、`core.cause`、`core.nextStep`、`mustRead`、`park`、`touchedFiles` 派生只读 brief；不回写存储。
- 旧版本 schema 遇到新字段时的行为属于**降级风险**：除了 `brief`，旧版本也不认识后续加入的 `sources`。2026-10-19 用真实旧代码 `be8ebf4`（引入 `brief` 前的最后一个提交）验证：旧代码能打开新文件，读取时 strip `brief` 与 `sources`，写回后两者从磁盘永久消失。因此升级前应备份 `~/.dsh/storages/todo_assistant.json`；旧版本只用于只读诊断，不要在旧版本中写回新数据。
- 当前不做自动迁移。未来若出现不兼容的必填字段/结构变化，必须先提供备份、迁移和回滚方案，再提升 `DOMAIN_VERSION`；不能把“永远不升版本”当作原则。
- 当前专项验证：`scripts/verify-brief.mjs` 覆盖 version-1 fixture、brief round-trip、旧卡派生、旧 schema strip/写回丢失模拟；`scripts/verify-gate1.mjs` 覆盖 §8.0 的确定性 S1–S10；`scripts/verify-legacy.mjs` 用 `be8ebf4` 的真实旧代码做读取/写回/备份恢复演练。
- 备份/恢复：升级或尝试降级前，停止写入后复制 `~/.dsh/storages/todo_assistant.json`；恢复时关闭 DSH、替换文件、再启动。`verify-legacy.mjs` 的恢复断言只使用临时副本，不是对真实 `~/.dsh` 存储的演练。
  当前没有自动迁移步骤；若未来提升 `DOMAIN_VERSION`，必须同时提供迁移脚本和回滚到备份的步骤。
- 降级风险：旧版本读取会 strip 未知 `brief`/`sources`，写回会永久丢失这两个字段；因此旧版本只能用于只读诊断，
  不要让旧版本写回新数据。

**关键点**

- `major.minor` 是后加的（M7 之后）：**major = 第几个会话**（同一根会话共用，子会话上溯到根），
  **minor = 该会话内第几张**；无会话的卡每张新开 major、`minor=0`。编号在创建时算好并持久化，
  删除不重排（只有删掉组内最高 minor 才会复用）。老记录在启动时迁移成 `1.<旧编号>`。
  对话里用 `#3.2`，`id` 只做持久化主键；工具入参两种都接受。
- `request` 是**开发者原话**：`todo_add` 时 host 从当前轮的 `user/message`（`source.kind === 'user'`，
  即人打的，不含文件变更/技能等系统注入）逐字抓取，≤8000 字；它进 `todo_read` 默认输出、
  新会话种子与右栏详情，供开发者对照与纠错。模型不参与这段文本的生成。
  消息里有 `#DB … #/db` 时只取对应块（标记剥离），多块按顺序各取一段并记 `block` 序号；
  需要修订时 `patch.request.text` 可覆盖（只用于修复早期捕获）。
- **未标记消息的 request 范围**：`todo_add` 接受 optional `requestExcerpt`。有标记时忽略它，完整记录标记块；
  无标记时只保存模型给出的、与该待办有关的原文片段。`requestExcerpt:''` 表示该消息只有创建指令或包含其他任务，
  不保存 request；非精确匹配的摘录不保存，并返回 warning。若模型省略摘录，单段消息保留全文；多段消息只保留第一段，
  第一段若只是创建指令则不保存 request。这个回退不依赖模型参数，避免把同一条消息里的后续任务静默并入 request。
- `park[].label` + `why` 的存在，是为了让开发者和 AI 在**不读正文**的情况下判断要不要读。这是"有备无患"能成立的前提
- `notes[]` 只追加。轮 6 的补充就是一条 note
- `todo_write` 的类型区分不做强类型，靠 `status` + 视图（tab）区分；`defect` 要求 `cause` 和下一步（`nextStep` 或 `brief.nextAction`），`idea` 要求 `intent`、`cause` 可空

---

## 5. 工具设计

原则：**不给 AI"写总结"的自由接口，只给"填表"的窄接口。字段本身就在逼它挑选。**

### 5.1 `todo_add`

必填：`title`、`kind`、`touchedFiles`、`mustRead`
可选：`brief`、`nextStep`、`requestExcerpt`、`forceCreate`、`symptom`、`cause`、`intent`、`park`、`symbols`

> `brief.nextAction` 是规范下一步。`nextStep` 只作为旧调用兼容镜像：
> 只给 `brief` 可以建卡；只给 `nextStep` 且不带来源字段仍兼容；两者同时给且冲突时以
> `brief.nextAction` 为准并返回 warning；两者都缺时拒绝，绝不自动编造下一步。
> 无 brief 且只有 `touchedFiles`/`park`/`symbols` 时返回 `todo/brief-required`；brief 只有 leads 时返回
> `todo/brief-source-only`；`forceCreate` 不能绕过质量门禁。旧式 `nextStep` + 真实文件路径按“只有路径”处理，
> 需要补简报或至少一条 `mustRead` 事实。
> 去重命中时先返回候选，模型必须询问开发者；确认新建后才可传 `forceCreate:true`，确认补充则用 `todo_note`。

handler 内校验，超限直接报错让它重写：

| 约束 | 值 | 目的 |
|---|---|---|
| `title` 长度 | ≤ 40 字 | 保证标题可扫读 |
| `mustRead` 条数 | ≤ 3 | |
| `mustRead[].text` | ≤ 200 字 | 超了说明在写总结，不是选材 |
| `park[].label` | ≤ 30 字 | |
| `park[].why` | ≤ 60 字 | |
| `touchedFiles` 为空 | 警告但放行 | 宁可缺，也要能记 |
| `brief.goal` / `brief.nextAction` | 必填（提供 brief 时） | 简报必须能回答“做什么、从哪开始” |
| `brief.confirmed` | ≤ 6 条 | |
| `brief.constraints` / `leads` / `openQuestions` | 各 ≤ 4 条 | |
| 单条 brief item | ≤ 200 字 | |
| brief 总长度 | 软 1200 / 硬 1600 | 超软警告；超硬拒绝，不静默截断 |
| 只有 leads、没有事实/约束/问题 | 拒绝 | 来源路径不能冒充任务说明 |
| 无 brief、无 mustRead/现象/原因/意图，只有文件/符号/备查 | 拒绝（`todo/brief-required`） | 新任务不能只给来源；无来源的简单旧式卡仍兼容 |

工具描述必须写死：

> 只写与本待办相关的部分；与本待办无关的内容一概不写。
> 写卡时只使用你上下文里仍然可见的内容。若判断早期内容很可能相关但已被压缩，先询问开发者是否回读，不要自行调用回读工具。
> 只有在开发者明确同意后才能调用本工具。

`origin` / `code` 由插件自动填，不需要 AI 出力。
`commit` 取值：host 侧 `git rev-parse HEAD` / `git rev-parse --abbrev-ref HEAD`；`subprocess` 不可用时降级读 `.git/HEAD`。

> 路径归一化：`todo_add` / 手工建卡写 `touchedFiles` 与 `symbols[].file` 时，绝对路径按工作区剥成相对路径、
> 去 `./` 与尾斜杠、反斜杠转正斜杠、去重；去重比较也用归一化后的形式。这样"填什么格式"不再依赖模型自觉。

### 5.2 `todo_note(id, text, kind)`

`text` ≤ 300 字。追加，不重写。

### 5.3 `todo_read(id, part?)`

- 无参 → 先 `brief`（goal/why/confirmed/constraints/leads/nextAction/openQuestions），再 `mustRead` 正文 + `park` 的 label/why 列表（不含正文）+ `code` 坐标
- 旧卡没有 `brief` 时返回只读派生 brief，并带 `briefSource: 'derived'` 与质量 warning
- `part: 'park:2'` → 该条正文（M3 先给整条指针含 `where`；正文回读属 M6）
- `part: 'notes'` → note 历史

> 实现说明（M3）：`mustRead` 每条本来就 ≤200 字、是"必读材料"，所以放进默认返回；
> `park` 仍只给 label/why。

### 5.4 `todo_list(workspace?, status?)`

极简输出，一行一条：`id / title / status / kind`。

### 5.5 `todo_recall(id, slice?)`

压缩兜底的正确形态：**先给目录，再给正文。**

- 无 `slice` → 只返回原会话该 `seqRange` 的**清单**：每条消息的轮次、角色、首行 40 字、token 估算
- `slice: [from, to]` → 才返回正文

清单很便宜（几十 token），足够开发者与 AI 决定"读不读、读哪段"。

**硬规矩：AI 不得自行 recall，必须先问开发者。**

> M6 实现说明：清单与正文都来自 `ctx.sessionQuery.readSession(id)` 的原始日志（不是当前 surface），
> 所以被压缩替换掉的内容仍读得回原样；每条消息截 2000 字、整次上限 12000 字；token 估算优先用
> `ctx.tokenMeter.estimateMessage`，缺失时按 ~4 字符/token 粗估。手工卡的 `seqRange` 是 `[0,0]`，
> 返回 `unavailable`。

### 5.6 `todo_status(id, status)`

MVP 之后补的第六个工具：AI 侧**唯一**能改状态的通道（`open` / `doing` / `done` / `dropped`）。

- 描述里写死：**先得到开发者明确确认**再改；做完会问一次是否标完成，同一个会话问过就别重复问；
- 只动 `status` 一个字段，事实类信息仍走 `todo_note`；
- 入参与其它工具一致：`3.2` / `#3.2` / `td_xxx`。

---

## 6. 捕获时序

三条入口，一个出口（`todo_add`）。

### 6.1 A：AI 发现 → 汇报 → 同意 → 写卡

```
AI:  发现 xxx bug，影响 yyy，是否记为待办？
人:  加
AI:  [todo_add: 只填本待办相关字段]
```

### 6.2 B：开发者点「记为待办」

一条 AI 回复里可能同时有主任务结论和额外发现，**不能默认整条都抓**。

流程：

1. 点按钮 → 弹出选择层，把该条回复按段落列出
2. 疑似旁支的段落**预选中**（靠关键词 / 文件路径与现有待办的弱匹配）
3. 开发者可补一句话（"这其实是个 bug" / "这是个想法"）
4. 确认 → 插件把"请把这些记为待办：<选中段落>"作为一条消息发给 Agent；或点「插入到对话框」
   把同一段文本放进输入框（不发送），便于一次补多条
5. Agent 调 `todo_add`

**为什么绕一圈回给 Agent**：只有 Agent 手里有那段对话的来龙去脉，插件只能拿到文本。多一轮，换来"筛选"由有这个能力的一方做。

便捷路径：**Shift+点击 = 整条**记为待办（用于回复本来就是纯旁支发现的情况）。

> 实现说明：段落预选只用"正文里的关键词 / 文件路径"正则；便捷路径落地为 Shift+点击（长按与文本选择冲突）。
>
> 面板材质对齐官方弹层：遮罩 `--dsw-alias-bg-mask-1` + `--dsw-mask-blur`，卡片
> `--dsw-alias-bg-layer-2` + `--dsw-radius-panel` + `--dsw-elevation-prominent`（与 `Modal.module.css` 同一套）。
>
> **决定（2026-10）：弱匹配不做，保持现状。** 理由：关键词/路径已覆盖主场景；而与已有卡片做模糊
> 对照的收益有限——B 流程本来就会把选中段落发回会话，由拿着正文的 Agent 判断相关性更准，
> 面板里的模糊提示反而可能诱导错误勾选。

### 6.3 C：开发者直接说"记一下 xxx"

走 A 的出口。

### 6.4 压缩兜底

> **决定（2026-10）：不加机械审批，保持"工具描述里的硬规则"。** 依据：两次行为探针（给一个
> "早期轮次已压缩、需要知道当时为什么排除方案 A"的诱惑场景）模型都先 `todo_read` 再停下来
> 请求批准，没有自行调 `todo_recall`；持久化日志里 `todo_recall` 调用为 0。
> 若将来出现一次未经许可的回读，再给它加 UI 审批（用户点"批准回读"才执行）。


写卡时若 AI 判断早期内容可能相关但已不在上下文：

1. AI 先问："轮 1/2 已被压缩，疑似相关，要我回读吗？"
2. 开发者同意 → `todo_recall` 先给目录 → 再决定读哪段 → 才读正文
3. 开发者拒绝 → 卡片只写当前可见部分，`park` 里留一条"早期轮次可能有相关内容，未回读"

### 6.5 去重

`todo_add` 执行前，在同一 `workspace` 的 `open`/`doing` 卡里计算：

- `touchedFiles` 交集 ≥ 1，且
- 标题字符相似度 ≥ 0.55，**或** `brief.goal` 相似度 ≥ 0.65。

`brief.why` 只参与解释，不单独决定重复。若双方都有 goal 且相似度低于 0.2，则即使标题相似也不拦，
避免“同一文件但目标不同”的合理新卡被误拦。命中时返回候选卡、共享文件、标题/目标相似度和
`matchReason`，由模型告知开发者并询问：补充已有卡则调用 `todo_note(#6)`，确认新建则重试
`todo_add(..., forceCreate:true)`。相似度不是合并或取消创建的授权；`forceCreate` 只能在开发者明确确认后使用。

这直接回应"第一眼没看出来导致重复添加"的问题。

> M7 实现说明：标题/目标相似度用字符 bigram 的 Dice 系数（忽略大小写/空白/标点）。
> `touchedFiles` 为空的捕获不参与去重（只靠文本误判太多）。命中返回 `status: duplicate` 而不是建卡，
> 由模型询问开发者：确认补充用 `todo_note` 合并，确认新建用 `forceCreate` 继续。T3 已把 brief.goal 纳入辅助信号；
> why 仅用于解释；相似度不是自动决策。

### 6.6 D：标记式捕获（`#DB … #/db` / `#MEMO … #/memo`）

第四条入口，**输入即同意**，不再追问：

- 开始标记 `#DB`/`#db`，或英文 `#MEMO`/`#memo`（两者等价）；结束标记 `#/db`/`#/memo` 可省略，两种可互换；
- 识别点在 host 的 `agent/inbox/claimed`（**早于 prompt 装配**；扫 `user/message` 会晚一步，
  因为 loop 在装配之后才 append 用户消息）；
- 跳过围栏代码块与行内代码，且标记必须不在词内（`abc#db` 不算）；
- 命中后下一次装配注入一次性指令："这是明确同意，用 `todo_add` 原样记下，别再问"；
- **卡片里的「开发者原话」只取标记内那一段**，标记本身不入库；一条消息多个标记时按顺序各记一段。

### 6.7 E：输入框辅助（补全 + 引用框）

都在客户端 `MarkerCompletion` 一层，只用公开的 `useInput` + `inputActions`，不碰编辑器内部：

- 打 `#db` / `#memo`（前面是空格或行首）→ 补成 `#DB  #/DB` / `#MEMO  #/MEMO`，光标落在两个空格之间；
  结束标签大写；**只在输入时补**（删除不补）；开头标签被破坏时连同结束标签与空格一起删掉；
- 打 `#` → 弹出卡片引用框：上方未完成（最多 8 条）、不满 8 条时加分割线补已完成；
  排序为「本会话 → 编号从大到小」；`#i`/`#b`/`#d` 这类前缀过滤类型，
  完整词 `#idea`/`#bug`/`#defect` 同样生效；候选由 `list` 的 `bySession` 查询只取当前会话所属工作区；
  无会话 ID 时退回全部工作区；会话或 cwd 缺失时回退 INBOX，工作区解析不到时使用会话 cwd，解析器异常时回退 INBOX。
- 选中后插入 `#x.y「标题」 `（带尾随空格）；`「」` 被删坏时整段标题删除，只留编号；括号完整时正文随便改。

> 官方 `InputTriggerController` 的 `lexicon` 只有 `'/'` 和 `'@'` 两个键，没有注册第三个触发符的公开入口，
> 所以 `#` 完全是自绘的：触发识别、候选渲染、插入都是插件自己的代码，不享受官方 chip/序列化/撤销合并。

---

## 7. 检测规则

范围：**只看本会话新建的、状态为 `open`/`doing` 的卡。**

每轮结束算一次，零模型调用：

| 信号 | 来源 |
|---|---|
| 本轮触及的文件 | 该轮 tool call 的 read/write/edit/grep 路径 |
| 本轮触及的符号 | 从触及文件提取的、出现在 `code.symbols` 中的名字 |
| commit 是否变化 | 与 `code.commit` 比较 |

命中条件（配置项，默认）：**至少 1 个精确文件路径命中**，或 2 个以上路径段相同。

命中后：

- 往下一步注入一行：`本轮触及 x.ts，与待办 #6「…」相关；若有值得留的证据可调 todo_note`
- 右栏该卡亮角标

**为什么这么粗**：误报代价是一行文字；漏报可事后补。判定本身不该花钱。

> M4 实现说明：只有"本轮触及的文件"这一路接了（`session/event` 的 `tool/call` 参数）。
> 命中后按"每轮每卡最多一行"去重，注入走 `systemPrompt.context`（装配即消耗）。
>
> **决定（2026-10）：符号与 commit 两路不做。** 两路本身也是零模型调用（只是本地读文件 / 跑 git），
> 所以这不是成本问题，是质量问题：卡的 `code.symbols` 由模型写卡时填、经常为空；符号名是通用词
> （`token`/`refresh`），共享一个就误报；commit 在这套工作流里大多是"陈旧性"信号而非"相关性"信号，
> 且每步多一次读文件/跑 git 会拖慢每一步。文件路径（精确或 ≥2 段目录）已覆盖"又动了同一个地方"这一主场景，
> 漏掉的是"文件移动/改名、只改符号、按符号 grep"三类，代价是少一行主动提醒，可由 `todo_list` 或开发者点名补上。
> 路径写入侧的归一化（见 §5.1 脚注）进一步降低了"格式写错导致永不命中"的概率。

---

## 8. 右栏 UI

用右栏现有的 tab 机制（`ctx.sidebarRightTabs.register` + `sidebar.right.pane.tab`），**不替换整个右栏**——这样和 files / terminal 共存，升级也不容易坏。

```
┌─ [待办助理] [files] [terminal] ─────┐
│ [工作区 ▾ my-project]      [收件箱]  │
├─────────────────────────────────────┤
│ 未完成 · 待修复 · 待添加 · 已完成 · 全部 │
├─────────────────────────────────────┤
│ ⬤ 鉴权 token 刷新后 401             │
│   refresh 时未带 rotation…          │
│   src/auth/router.ts  +2            │
│   3 条补充 · [处理 ▾]               │
├─────────────────────────────────────┤
│ ⬤ 支持批量导入                      │
└─────────────────────────────────────┘
```

- **工作区切换 + 全局收件箱**：两层结构
- **tab 是视图不是类型**：同一张卡可同时出现在多个视图；AI 判错类别也只是换个 tab 看
- **手动编辑（必做）**：标题就地编辑、**编号左侧 radio 标完成**、`×` 菜单（删除 / 归档 / 取消）、note 删除
  理由：标题不合开发者想法会导致"第一眼没看出来 → 重复添加或延迟处理"；删 note 比让 AI 改更快
- **状态只有三个面**：待处理（radio 空）、已完成（radio 实心）、已放弃（`×` → 归档，圆点虚化）；
  `doing` 不再使用；卡片不显示独立的类型文字标签，未完成卡的类型由 radio 边框颜色区分（idea/defect），`×` 在右上角
- **没有"正在处理"标记**：会话接手不再写 `handling`（字段保留以兼容旧数据，UI 不显示、也不写入）
- **「处理」菜单**：`新会话中立即执行` / `插入当前会话`。新会话开场会明确要求先只读代码/资料并给出方案，不修改文件；开发者确认方案后才进入实现。需要开发者决定、确认方案或补充信息时，两个入口都要求在任务处理过程中调用 DSH 的 `ask_user_question` 并等待回答，不能先自行决定，也不能把问题留到完成后的回复。
- **五个视图**：未完成（open+doing）、待修复（defect）、待添加（idea）、已完成（done+dropped）、全部。
  数量口径一致：未完成 = 待修复 + 待添加，全部 = 未完成 + 已完成
- **筛选记忆**：选中的视图写 `localStorage['todo-assistant:view']`，重启后仍停在上次那个
- **范围跟随当前工作区**：默认 = 当前会话所属工作区；手动选的范围只对当时那个工作区有效，
  切到别的工作区会自动跟过去，切回来时之前的选择还在
- **通用规则**：面板里一块可折叠的编辑区，按工作区保存（`rules` 表）；「新会话中立即执行」时
  把该卡工作区的规则拼进种子

---

## 9. MVP 切分

| 阶段 | 内容 | 可独立交付 |
|---|---|---|
| M1 | 右栏 tab + 卡片 CRUD + 存储 + 手动新建 | ✅ 纯手工容器，先能用 |
| M2 | `todo_add` 完整 schema + 坐标 + park | ✅ 捕获能力 |
| M3 | `todo_read` / `todo_note` + 详情展开 | ✅ 按需读取 |
| M4 | 检测规则 + 提醒 | ✅ |
| M5 | 新开会话 / 插入当前会话 | ✅ |
| M6 | `todo_recall` 目录 + 分页回读 | 可砍 |
| M7 | 去重合并 | 可砍 |

M1 就能交付"看得见、能改、能存"的待办区；M2 之后才开始真正省 token。

---

## 10. 待验证的技术点

编码前必须先探，不要假装已知：

1. **Client → Host 写通道**
   手动编辑卡片要客户端改 host 数据。走 `@Remote` 生成的 namespace，还是自定义 `webServer` 路由？纯 JS 插件里哪条最省事，需实测。

2. **自定义 storage domain 的注册方式**
   `storageDomain.open(spec)` 的 spec 形状、是否与 workspace 已有 domain 冲突，要读一遍实测。

3. **段落选择层能否拿到段落边界**
   `conversation.chat.assistant-actions` 的 props 是否带消息内容。拿不到就退化为"整条复制 + 开发者手动删减"，仍可用但体验降一级。

4. **实时更新通道**
   host 写卡后客户端如何刷新。候选：监听会话投影里的 `todo_add` 工具调用 → 重新拉取；tab 获得焦点时刷新。MVP 阶段够用。

### 10.1 与 10.2 的验证结论（已实测，2026-10）

**第 1 点：走 `/api` 通道上的 exact Fetch 路由，两条候选都不选。**

- `@Remote` 不可用于纯 JS 插件：装饰器只是标记，真正的 namespace 由 Typert 生成器在 TypeScript 构建期产出，再由 `@deepseek-ai/dsh-api-remotes` 在 Client 侧用**构建期确定的** `/remote` 值导入并 `ctx.remote.$mount()`。运行时插件加不进这个装配。
- `ctx.connection.rpc.handle()` 看着最合适，实际**在发布组合里不可用**：它挂路由时读的是 Connection 服务自己的 fiber（`get rpc()` 里 `const owner = this.ctx`），而那条 fiber 只 inject 了 `webRuntime`，因此必然抛
  `cannot get property "webServer" without inject`（实测，见 host.js 注释）。`intercept('/api', …)` 不碰 webServer，但 `/api` 上的中继已被 API Gateway 独占，后来者抛 "already has an interceptor"。
- 采用 **`ctx.connection.fetch.register({path:'/api/todo-assistant/<endpoint>', methods:['POST'], requestBody:'buffered', fetch})`**（Host）+ 同源 `fetch('api/todo-assistant/<endpoint>')`（Client）：
  - 路径必须写成 `/api/...`（`assertFetchRoute` 用 `endpointFromPath('/api', path)` 校验），它挂在 Connection 已有的 `/api` 前缀路由下，**信任围栏与 cookie 鉴权在进入 handler 之前就做完了**（实测：不带 cookie 的 POST 返回 401）；
  - handler 是标准 Fetch handler，请求体是裸 JSON payload，返回体是插件自己的 `{ok:true,value}` / `{ok:false,error}`，不套 Connection 的 RPC 信封；
  - Client 用 document-relative URL（`api/...`），挂载前缀由页面自行解析，这一点与 `createWebConnectionRpc` 的做法一致。
- 备选（未采用）：自己 `webServer.register` 一个 prefix 路由 + 自行调用 `ctx.connection.admit(req)`，等于把上面白拿的两件事重做一遍。

**第 2 点：`storageDomain.open(spec)` 可用，但有两个硬约束。**

- 域名字符集是 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`：**连字符不合法**，`defineDomain({name:'todo-assistant'})` 直接抛错。因此 domain 名取 `todo_assistant`，包名/通道/UI 仍是 `todo-assistant`。
- «与 workspace 已有 domain 冲突吗»：不冲突。facility 按 **name** 单开（同名第二次 open 报 `already-open`），不同名并存无影响；域路由走 `storage-domain` 的默认 backend（当前 profile 是 `json`），**不需要改任何 profile 配置**，卡片落在 `~/.dsh/storages/todo_assistant.json`（默认 `single` layout）。
- spec 形状即 §4 的 `{name, version, tables:{todos: domainTable(zodSchema)}}`；`open` 时逐条 `parse` 已存记录，schema 漂移会在 open 阶段炸出来（这是想要的 loud failure）。
- 实测脚本：`scripts/verify-domain.mjs`（用安装里的真实 storage/storage-domain/json backend，跑完增删改查 + 关域重开 + 单开校验，23 项断言）。

**额外发现：linked 包的解析与重启。**

`install_bundle` 对本地目录用 `pnpm add <abs path>`，profile 里得到的是**符号链接**（linked root）。linked 层导入安装内包（`@deepseek-ai/dsh-storage-domain`、`zod`）靠 app-boot 的 peer 拦截：路由表要求 linked root 已登记。**运行中的进程不会在安装后重建这张表**（`pluginPackages.replace` 只由启动路径构造），所以新装的 linked 包在**同一个进程里**无法解析这些导入；重启后（表在建表时包含该 symlink）即正常。结论：host 代码变更一律需要重启 dsh，浏览器 half 只需刷新页面。

**端到端实测（一次性实例，真实 HTTP + 真 cookie）**：`12/12` 通过 —— 列表、建档、改档、删除、非法输入稳定错误码、无 cookie 401、`~/.dsh/storages/todo_assistant.json` 落盘。

### 10.3 与 10.4 的验证结论（已实测，2026-10）

**第 3 点：段落选择层能拿到段落边界，但 props 不带正文。**

- `conversation.chat.assistant-actions` 的 owner props **只有 `messageId`**，没有消息内容；
- 正文可以从 `useChat` 快照反查：按 `node.data.finalNode.messageId === messageId` 找到节点，
  取 `blocks` 里 `kind === 'text'` 的段落；拿不到时才退化为"整条回复"；
- 因此 B 入口（§6.2）的实现是：按钮 → 面板按空行切段、关键词/路径预选 → 把选中段落作为一条
  用户消息 `prompt(mode:'queue')` 发回当前会话，由 Agent 调 `todo_add`。

**第 4 点：实时更新走"静默轮询"，不监听工具调用。**

- 面板每 4 秒拉一次 `list`，请求进行中或页面隐藏时跳过；没有变化就不重渲染；
- 不做"监听 `todo_add` 工具调用"的投影订阅：那需要挂 conversation 事件，复杂度不成比例；
  4 秒的滞后对"记下一条待办"这种频率完全够用；
- 自己写卡后不等轮询：创建/改状态/删卡都先做本地乐观更新，再用返回的行替换。



---

## 11. 安装与位置

```
源码：<本仓库绝对路径>/
        ↓  plugin_manager install_bundle（target = 上述绝对路径）
安装：~/.dsh/profiles/web/node_modules/
        ↓
当前 profile 的所有会话生效
```

- **源码不要放进 `~/.dsh`**，那是安装产物
- 不要手写 `~/.dsh` 下的 `package.json` / `cordis.patch.yml`，也不要在该目录跑 pnpm
- 改代码在工作区改，重新 `install_bundle` 一次
- `install_bundle` 需要审批，且影响整个 profile

---

## 12. 下一步

从 **M1** 开始。但先花一步验证 §10 的第 1、2 点——它们决定骨架怎么搭，避免界面写完发现数据通道不对。

> **M1 已完成**：右栏 tab（`sidebar.rightTabs.register` + `sidebar.right.pane.tab` 键位注册）、卡片 CRUD、`todo_assistant` 存储域、手动新建。
> **M2 已完成**：`todo_add` 工具（§5.1 全字段与硬约束）、`origin`（sessionId / turn / seqRange / cwd）、`code` 坐标（git，含 `.git` 兜底）、`park` / `mustRead` / `symbols`。`scripts/verify-domain.mjs` 通过 54/54。
> **M3 已完成**：`todo_read`（卡片 / `notes` / `park:n` 三种形态）、`todo_note`（追加、≤300）、`todo_list`（只给索引）、右栏详情展开与补充删除。`scripts/verify-domain.mjs` 通过 73/73。
> **M4 已完成**：`session/event` 收集 `tool/call` 路径、`step/end` 检测、`systemPrompt.context` 每步注入一行、右栏「相关」角标（`list` 带 `sessionId`）。`scripts/verify-domain.mjs` 通过 94/94。
> M4 实现取舍：只接路径信号，未接 commit 变化与符号反推（不在默认命中条件内，且需要额外 I/O）。
> **M5 已完成**：卡片「处理」→ 新开会话（`remote.session.create` + `prompt` 注入 L1 + 导航）或插入当前会话（`inputActions` 预填一句）、`handling` 绑定落库。`scripts/verify-domain.mjs` 通过 98/98。
> 实现取舍：「插入当前会话」只预填不自动提交（不替人发消息、不打断轮次）。
> **M6 已完成**：`todo_recall` 两段式（目录 / slice 正文），数据走 `sessionQuery.readSession` 的原始日志，token 估算走 `tokenMeter`。`scripts/verify-domain.mjs` 通过 109/109。
> **M7 已完成**：`todo_add` 建卡前做近似重复拦截（同工作区 + 共享触及文件 + 标题 bigram Dice ≥ 0.55），命中返回候选卡由模型询问开发者，确认后走 `todo_note`。`scripts/verify-domain.mjs` 通过 117/117。
> MVP 全部里程碑（M1–M7）完成。之后补了**卡片短编号** `x.y`：major = 第几个会话、minor = 会话内第几张，
> 子会话上溯到根、无会话卡 `x.0`、老记录迁移成 `1.x`，与 §3.11「现在切到 #6」的写法对齐。
> `scripts/verify-domain.mjs` 通过 145/145。
> 之后补了**完成闭环**：新增 `todo_status`（AI 唯一能改状态的工具，须先确认），
> 并把「改完后主动问是否标记完成」写进新会话种子与「插入当前会话」的提示词。
> 又补了**开发者原话**（`request`，host 从人打的 `user/message` 逐字抓取）与 **`#DB … #/db` 标记**
> （host 扫用户消息、跳过代码块、下一次装配注入一次性指令）。
> 后来补了 `#MEMO` 别名、`major.minor` 编号、`todo_status`、输入框 `#db` 补全、`#` 引用框、
> 筛选持久化与**工作区通用规则**（`rules` 表 + 新会话种子拼接）。`scripts/verify-domain.mjs` 通过 181/181。
>
> **Stage 1 / T1–T4 基础实现已完成；T5 / Gate 1 于 2026-10-19 严格复核为未通过**：TaskBrief schema、旧卡只读派生、brief-first 读取/UI、
> `brief.nextAction` 与 `nextStep` 的统一契约、brief 参与的重复检测、version-1 兼容均已实现。
> 当前 `scripts/verify-domain.mjs` 通过 262/262，`scripts/verify-brief.mjs` 通过 118/118，`scripts/verify-recall.mjs` 通过 35/35，
> `scripts/verify-gate1.mjs` 通过 63/63（S1–S10 39 项 + 契约/持久化 24 项），`scripts/verify-legacy.mjs` 通过 11/11，`git diff --check` 通过。
> §8.0 的确定性 S1–S10 全部通过；隔离语义探针为 5 通过 / 4 部分 / 1 未定（S3 把已定约束写进 `confirmed`、S4 多塞一条 `verified` 元约束、
> S5/S6 把阻塞缺口标成 `non-blocking`、S9 未经过 duplicate 门禁）。所有 `wouldCallRecall=false` 都是模型自述，不是调用轨迹。
> **Gate 1 UI 冒烟已由开发者验证（2026-10-19）**：`#` 引用框工作区筛选、完成/反向切换动画、减少动态效果、窄窗口布局、duplicate 提示均未发现问题。
> **Gate 1 当前未通过**：上述语义字段问题需要改 `todo_add` 描述并重启 DSH 后重跑探针；真实 UI 十场景、真实 `todo_recall` 轨迹、旧插件 UI、
> 真实用户存储的备份/恢复/迁移/回滚演练仍未验证。详见 `docs/GATE1-T5-ACCEPTANCE.md`。

> **与文档的已知偏差**（均为记录过的取舍，不是遗漏）：
> 1. §7 的三路检测信号只实现"触及文件"；符号与 commit **已决定不做**（见 §7 的实现说明）；
> 2. §6.2 的"长按 = 整条"落地为 Shift+点击；段落预选只用关键词/路径，**弱匹配已决定不做**（见 §6.2 脚注）；
> 3. §6.4 压缩兜底仍是行为约定（`todo_recall` 描述的硬规则），没有机械检测；
> 4. 子会话写卡现在**是明确允许的**（§3.4），编号归到根会话的组。

