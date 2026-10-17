**中文** | [English](README.en.md)

# 待办助理 (todo-assistant)

跨会话的旁支任务工作台：把会话里"先不做但别忘"的事记成卡片，之后单独开会话处理。
设计见 [docs/DESIGN.md](docs/DESIGN.md)。安装见 [安装](#安装)，许可见 [LICENSE](LICENSE)（MIT）。

当前功能：

- **右栏 tab**：五个视图（未完成 / 待修复 / 待添加 / 已完成 / 全部）、卡片 CRUD、详情展开、按工作区范围过滤（跟随当前会话）；
- **捕获**：`todo_add`（完整 schema + git 坐标 + mustRead/park + 开发者原话 + 路径归一化）、去重拦截、
  `#DB … #/db` / `#MEMO … #/memo` 标记、AI 回复上的「记录待办」段落面板、输入框 `#db` 补全与 `#` 引用框；
- **读取**：`todo_read` / `todo_note` / `todo_status` / `todo_list` / `todo_recall`（两段式原文回读）；
- **提醒**：每步零模型的路径相关性检测 + 下一步一行提醒 + 右栏「相关」角标；
- **交接**：卡片「开始任务」→ 新会话以卡片开场 / 插入当前会话；工作区级通用规则随新会话带上。

## 结构

| 文件 | 作用 |
|---|---|
| `host.js` | Host 插件入口：打开 `todo_assistant` storage domain，注册 `/api` 路由与 `todo_add` 工具 |
| `domain.js` | 领域声明（zod record schema）与纯逻辑：建卡、捕获校验、改卡、ID、L0 投影 |
| `api.js` | 数据操作与线协议：`list` / `create` / `patch` / `remove` / `note.add` / `note.remove` |
| `tool.js` | 六个工具定义：`todo_add` / `todo_read` / `todo_note` / `todo_status` / `todo_list` / `todo_recall` |
| `git.js` | 写卡时的代码坐标：`git rev-parse`（subprocess）优先，`.git` 文件读取兜底 |
| `detect.js` | 检测规则：工具调用 → 路径 → 卡片匹配 → 提醒行 / 角标集合 |
| `recall.js` | L2 回读：原始日志 → 目录（seq/轮次/角色/首行/token）→ 指定 slice 的正文 |
| `dedupe.js` | 近似重复：同工作区 + 共享触及文件 + 标题相似度 |
| `client.js` | 浏览器 half：右栏页签类型 + 卡片 UI（无构建步骤，只用 baseline `react`） |
| `scripts/verify-domain.mjs` | 无头验证：用安装里的真实 storage 栈打开 domain 并跑完整个线协议 |

`domain.js` / `api.js` 刻意不写任何包导入，测试脚本可以脱离 profile 直接驱动它们；
真实依赖由 `index.js` 注入 `createTodoSpec({ z, defineDomain, domainTable })`。

## `#DB` 标记（输入即同意）

在消息里写：

```
#DB 导出 CSV 时表头重复
第二行也算待办内容
#/db
```

- 开始标记 `#DB` / `#db`，或英文的 `#MEMO` / `#memo`（两者等价，同一捕获链路）；结束标记 `#/db` / `#/memo` **可省略**（省略时到消息结尾），两种结束标记可互换；
- **跳过围栏代码块与行内代码** —— 否则一条"讲解这个语法"的消息会把自己记成待办；
- host 在 `user/message`（只认人打的，`source.kind === 'user'`）上扫描，命中就排进该会话的队列；
- 下一次装配会注入一条一次性指令：告诉 AI「这段被标了 #DB，标记就是明确同意，用 todo_add 原样记下，不要再问」；
- 开发者原话（含标记本身）仍会逐字存进卡片的 `request`。

识别点在 host 侧（`agent/inbox/claimed`，早于 prompt 装配），所以不依赖 composer 的提交钩子；也不改发送流程。

输入框里有轻量补全：打 `#db` 会变成 `#DB  #/DB`，打 `#memo` 会变成 `#MEMO  #/MEMO`，光标停在两个空格之间。实现只用公开的 `useInput` + `inputActions`（先插 `#/db`、再把 `#db` 替换成 `#DB `），不碰编辑器内部与 DOM。

## 面板内的使用说明

右上角的圆形 `(i)` 按钮展开「待办助理使用说明」：插件定位、为什么值得用（记卡带现场、读卡省 token、主线不断、重复提醒、规则写一次）、按场景的用法（问 AI 记卡 / 事后 `#x.y` 接着做 / 一次多条 / `#db` 输入即记录 / `#` 引用 / 开始任务收尾 / 通用规则），以及 `#x.y` 编号含义。文案在中英两份 i18n 里，改措辞直接改 `client.js` 的 `help.body`。

## 段落捕获面板

点 AI 回复上的「记录待办」后：

- 面板列出该条回复的段落，关键词/路径命中的预选；
- 「插入到对话框」把选中的段落拼成同一条消息放进输入框（不发送），适合一次补多条；
- 「发送给 AI」直接作为一条用户消息入队，由 Agent 调 `todo_add`；
- 面板材质与官方弹层一致（mask + layer-2 + `--dsw-radius-panel` + `--dsw-elevation-prominent`）。

## 开发者原话

`todo_add` 落卡时，host 会把**当前轮里人打的用户消息**（`source.kind === 'user'`，跳过文件变更/技能等系统注入）逐字存进卡片的 `request.text`（上限 8000 字，超了标 `truncated`），模型完全不参与这段文本。

- 右栏详情第一块就是「开发者原话」，卡片元信息里也会出现「原话」标记；
- `todo_read` 默认输出里带 `developer request (verbatim)`；
- 新会话的种子把它作为「开发者原话」一节带上，接手会话的 AI 直接看到你的措辞。

如果消息里带了 `#DB … #/db`，**只记对应那一段**，标记本身不入库；一条消息里多个标记时按出现顺序各记一段（`request.block` 记序号）。识别点允许标记紧跟在中文标点后（`两条：#db …`），但贴在单词里（`abc#db`）不算。

这样 AI 的理解有偏差时，你能对着原话立刻纠正；它也永远不会被"总结"掉。

## 工作区通用规则

右栏面板里有一块可折叠的「通用规则」，按工作区保存：

- 存在 `todo_assistant` 域的 `rules` 表里，key = 工作区路径（`rules.get` / `rules.set` 两个端点）；
- 点「处理 → 新会话中立即执行」时，会把**该卡所在工作区**的规则拼进开场种子（放在卡片内容之前）；
- 留空即删除该工作区的规则；
- 只作用于插件自己创建的新会话；你手动新建的会话不会带上（要全局生效得挂系统提示词，那是另一种取舍）。

## 完成闭环

- AI 侧新增 `todo_status(id, status)`：唯一能改状态的工具（`open` / `doing` / `done` / `dropped`），描述里写死**必须先得到开发者确认**；
- 新会话种子与「插入当前会话」的提示词里都带了这句：
  「改完后主动问开发者是否把 `#x.y` 标记为完成，确认后再调 `todo_status`」；
- 于是接手一张卡后，AI 会在收尾时问一次，得到肯定回答才落 `done`，不需要你自己去右栏改。

## 编号

每张卡有一个短标签 `#3.2`，与内部 id（`td_x7k2`）并存：

- **major（点前）= 第几个会话**：同一根会话共用一个 major，在该会话第一张卡时分配（全局最大 major + 1）；
- **minor（点后）= 会话内第几张**：组内最大 minor + 1；
- **子会话不算新会话**：沿 `header.parentSession` 上溯到根，卡片归到根的组；
- **没有会话的卡**：每张新开一个 major、minor 固定 0（`x.0`）；
- **创建时定号并写进记录**：之后删除不重排；只有删掉组内最高 minor 后，同组下一张才会复用该号（已接受）；
- **老卡片迁移**：本方案之前的卡一次性变成 `1.<旧编号>`（`1.1`…`1.N`）；迁移后旧会话再进新卡会另开 major —— 历史桶不吸收新卡；
- 右栏、工具输出、提醒行都用 `#x.y`；入参接受 `3.2`、`#3.2` 和 `td_x7k2`。

## 数据落在哪

- domain 名是 **`todo_assistant`**（下划线）：storage 层强制 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`，
  连字符会被 `defineDomain` 直接拒绝。
- 走 `storage-domain` 的默认 `json` backend，所以卡片落在 `~/.dsh/storages/todo_assistant.json`（单文件 layout）。
- `workspace` 存会话所属工作区的规范化路径；不属于任何仓库的卡放 `inbox`。

## 捕获（M2）

`todo_add` 是**表单**，不是自由写总结：

- 参数固定为 `title / kind / nextStep / touchedFiles / mustRead`（必填）+ `symptom / cause / intent / park / symbols`（可选）；
- 硬约束在 handler 里二次校验，超限直接报错让模型重写：`title` ≤40、`mustRead` ≤3 条且每条 ≤200、`park.label` ≤30、`park.why` ≤60；`touchedFiles` 为空只警告不拦截；
- 工具描述写死三条行为约束：**必须先得到开发者明确同意**、只写与本待办相关的部分、已压缩内容不得自行回读；
- `touchedFiles` 在写入时**归一化**：绝对路径按工作区剥成相对路径、去掉 `./` 与目录尾斜杠、反斜杠转正斜杠、去重；工作区之外的绝对路径保持原样。所以模型写 `/Users/.../src/a.ts` 也能参与路径提醒与去重（两者都按归一化后的形式比较）。
- `origin`（sessionId / turn / seqRange / cwd）与 `code`（commit / branch，来自 `git rev-parse`，subprocess 不可用时读 `.git/HEAD` + refs / packed-refs）全部由 host 填，模型不产出；
- `workspace` 由 session cwd 经 `workspaceRegistry.resolveByPath` 归一化，和右栏的工作区过滤对齐。

## 读取（M3）

- `todo_list(workspace?, status?)`：**只有索引**（id / 标题 / 状态 / 类型），默认看本会话工作区里 `open`+`doing` 的卡；`workspace: '*'` 跨工作区。
- `todo_read(id, part?)`：无参返回卡片本体（core + `mustRead` 正文 + `park` 的 label/why + 坐标 + 触及文件 + note 数）；`part: 'notes'` 给补充历史；`part: 'park:n'` 给该条备查指针（含 `where`，正文留给 M6 的 recall）。
  - 说明：`mustRead` 每条本来就 ≤200 字，是"必读材料"，所以放在默认返回里；`park` 只给 label/why，正文按设计不主动加载。
- `todo_note(id, text, kind?)`：追加，`text` ≤300 字，`kind` = supplement / evidence / status；先校验再落库，不重写卡片。

右栏卡片右上角的 `⌄` 展开详情（同一份数据走 `POST /api/todo-assistant/detail`），可直接删补充。

## 检测与提醒（M4）

零模型调用，全部在 host 侧算：

- **信号**：`session/event` 里的 `tool/call` 参数（`read`/`write`/`edit`/`read_image` 的 `file_path`，`grep`/`glob` 的 `path`），按会话 + 轮累积；
- **范围**：只看本会话创建、状态 `open`/`doing` 的卡（`origin.sessionId` 匹配）；
- **命中条件**（默认）：精确文件路径相同，或共享目录前缀 ≥ 2 段（`src/auth/router.ts` vs `src/auth/token.ts` 命中；`src/a.ts` vs `src/b.ts` 不命中）；
- **每轮每个卡片最多提醒一次**：`step/end` 触发检测，`turn/start` 重置本轮预算，已提醒的卡不会在同轮重复；
- **注入**：`ctx.systemPrompt.context({ name: 'todo-assistant/reminder', order: 130, text })`，在下一次装配（同轮下一步）给一行：
  `A file touched this step (src/auth/router.ts) relates to todo #td_x7k2「…」; call todo_note if there is evidence worth keeping.`
  装配即消耗，下一轮之前不会再出现；
- **角标**：`list` 请求带上 `sessionId`，命中卡在 L0 上带 `hit: true`，右栏显示「相关」并描边；`turn/start` 重置。

未接的信号（DESIGN §7 已决定不做）：commit 变化、从触及文件反推符号。两者也是零模型调用，问题在质量——卡的 `code.symbols` 常为空、符号名是通用词易误报、commit 多是陈旧性信号；路径信号已覆盖"同一个地方又动了"这一主场景，漏的是"文件移动/改名、只改符号、按符号 grep"三类。

## 原文回读（M6）

`todo_recall(id, slice?)` 是 L2，两段式，**最贵的一次读取**（正文会永久留在上下文里、每步重复计费）：

1. 不给 `slice` → 目录：卡片 `origin.seqRange` 里每条消息的 `seq / 轮次 / 角色 / 首行 40 字 / token 估算`，外加总量；
2. 给 `slice: [from, to]` → 只返回这一段正文（每条消息截 2000 字、整次上限 12000 字，超了标注 truncated）。

数据来自 `ctx.sessionQuery.readSession(id)` 的**原始日志**（不是当前 surface），所以即使那段历史已被压缩替换，也能读回原貌；token 估算优先用 `ctx.tokenMeter.estimateMessage`，没有就按 ~4 字符/token 粗估。

工具描述里写死了硬规矩：**不得自行 recall，必须先征得开发者同意**；先给目录，再由开发者选段。

这条约束是**指令而非强制**（没有 UI 审批拦着）。两次行为探针（"早期轮次已压缩，需要知道当时为什么排除方案 A"）里模型都是先 `todo_read`、再停下来请求批准，日志里未授权调用为 0；据此决定**不加机械审批**，真出现一次漏网再加（DESIGN §6.4）。

手工建的卡 `origin.seqRange` 是 `[0,0]`，没有可回读区间，会返回 `unavailable`。

## 去重（M7）

`todo_add` 落库前先算一遍"这是不是同一张卡"（§6.5）：

- 候选范围：同 `workspace`、状态 `open`/`doing` 的卡；
- 命中条件：至少 1 个 `touchedFiles` 精确相同 **且** 标题相似度 ≥ 0.55（字符 bigram Dice，忽略大小写/空白/标点）；
- 命中时**不建新卡**，返回 `status: 'duplicate'` + 候选 id/标题/相似度/共享文件，让模型去问开发者；开发者同意后用 `todo_note` 把新事实追加到那张卡；
- `touchedFiles` 为空的捕获不参与去重（只靠标题太容易误判）。

误判代价是模型多问一句，比"同一件事两张卡"便宜。

## 处理（M5）

卡片上的「处理」展开两个动作（DESIGN §3.11）：

- **新会话中立即执行**（菜单里的第一个动作，原文案「新开会话」）：`ctx.remote.session.create({ workspaceId | cwd })` → `.prompt({ mode: 'queue', content: [{type:'text', text: seed}] })` → `ctx.uiWorkspace.openSession(sessionId)`。
  `seed` 是卡片的 L1：标题、现象/原因/意图、下一步、触及文件、必读（含正文）、备查 label/why、写卡时的 commit、补充条数。新会话从一开始就知道自己在处理哪张卡。
- **插入当前会话**：用 `inputActions.captureInsertion()` + `insertText()` 往当前输入框里插一句
  `现在切到待办 #1.3「…」：先用 todo_read 读它，再按里面的「下一步」继续；改完后问我是否标记完成。`
  **只预填、不自动发送** —— 不替人发消息，也不打断正在跑的轮次；回车由开发者按。

两种方式都会在卡片上记 `handling: { sessionId, at }`（`POST /api/todo-assistant/handle`），
列表与详情都**不再显示**处理标记（2026-10 移除）：会话接手只创建/发送种子，不写 `handling`。
字段仍保留在数据模型里以兼容旧卡，`todo_read` 也还能读到，但 UI 不写入、不展示。

关联改动：卡片的状态不再用下拉菜单——编号左侧的 radio 直接标完成/取消，`×` 菜单给「删除 / 归档 / 取消」，
kind 标签移到左下角，`×` 移到右上角。

> 与设计的一处偏差：设计里「处理」是卡片上的 `[处理 ▾]` 菜单；这里同样是点一下展开两个选项，
> 只是菜单行内展开而不是浮层。

## 客户端 → Host 写通道

形态：**`/api` 通道上的 exact Fetch 路由**。不是 `@Remote`，不是 `rpc.handle`，也不是自建
`webServer` 路由。

- Host：`ctx.connection.fetch.register({ path: '/api/todo-assistant/<endpoint>', methods: ['POST'],
  requestBody: 'buffered', fetch })`。路由挂在 Connection 已有的 `/api` 前缀下，**Host/Origin
  信任围栏与浏览器 cookie 鉴权在进入 handler 之前就生效**（无 cookie → 401）。
- Client：同源 `fetch('api/todo-assistant/<endpoint>')`（document-relative，兼容挂载前缀）。
- 不用 `@Remote`：那些 namespace 由 TypeScript 装饰器在构建期生成，再由应用自己的 `ctx.remote`
  装配挂载；纯 JS 插件没有这条构建链。
- 不用 `ctx.connection.rpc.handle()`：它挂路由时读的是 Connection 服务自己的 fiber
  （`get rpc()` 里 `const owner = this.ctx`），那条 fiber 只 inject 了 `webRuntime`，必然抛
  `cannot get property "webServer" without inject`。`intercept('/api', …)` 不碰 webServer，但
  `/api` 的中继已被 API Gateway 独占。

线协议（裸 JSON，不套 Gateway 信封）：

```
POST /api/todo-assistant/<endpoint>
{ ...payload }
→ { "ok": true, "value": ... }
→ { "ok": false, "error": { "code": "todo/title-required", "message": "...", "details": {} } }
```

## 验证

离线（不需要启动 GUI，不动 profile）：

```bash
node scripts/verify-domain.mjs
```

它用本地 dsh 安装里的真实 `storage` / `storage-json` / `storage-domain` 打开本插件的 domain，
跑完增删改查与 note 追加/删除，最后关闭再重开，确认记录跨重启存活。

安装后（当前 profile）：

```bash
# 1. 已激活
#    在会话里 cordis_inspect_query → Slots.listSubTree(root: "sidebar.right.pane.tab")
#    应看到 key = "todo-assistant" 的 occupant
# 2. 冒烟调用（需要浏览器 session cookie，见下；无 cookie 应返回 401）
curl -sS -X POST "http://127.0.0.1:3080/api/todo-assistant/list" \
  -H 'content-type: application/json' \
  -H 'Host: 127.0.0.1:3080' -H 'Origin: http://127.0.0.1:3080' \
  -b "$COOKIE" \
  --data '{"all":true}'
```

cookie 就是浏览器里那份 `dsh-auth-*`（签名密钥在 `~/.dsh/.credentials.yaml` 的
`client-connection/browser-session` 记录里；签名 key 要先 base64url 解码）。

## 安装

三种方式，任选一种。都需要在 DSH 里调用 `plugin_manager install_bundle`（需要审批），装完**重启 dsh**。

**1. 从本地目录（开发用）** —— 源码留在这里，不要放进 `~/.dsh`：

```
plugin_manager install_bundle  target = <本仓库绝对路径>
```

**2. 从 GitHub 直接装** —— 不用先 clone：

```
plugin_manager install_bundle  target = https://github.com/zangoose335/dsh-todo-assistant.git
```

想锁版本就在地址后加 `#<commit>`，例如 `...#77215f3`。

**3. 从 npm（发布后）**：

```
plugin_manager install_bundle  target = todo-assistant@0.1.0
```

`install_bundle` 要求 PATH 里有 pnpm（本机通过 `corepack enable pnpm` 提供）。
方式 1 装完后 profile 里是一个符号链接：

```
~/.dsh/profiles/web/node_modules/todo-assistant -> <本仓库绝对路径>
```

不同方式装的是**同一个包名**，切换前先 `remove_bundle` 掉旧的那份。

**必须重启 dsh** 才会加载 host half：linked 包的安装内导入（`zod`、`@deepseek-ai/dsh-storage-domain`）
依赖启动时建立的 profile 解析表，运行中的进程不会在安装后重建它。之后每次改 host 代码都要重启；
只改 `client.js` 刷新页面即可。

## 打开 tab

右栏 → 顶部 `+`（Add）打开 guide → 点「待办助理」。页签布局按会话记在 localStorage，重开仍在。

## 许可证

[MIT](LICENSE) © 2026 黑桃伍
