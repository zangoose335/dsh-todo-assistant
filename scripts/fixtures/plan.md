# 计划导入示例

用一个 Markdown 计划验证 B3 的解析、预览与 round-trip。

Decisions:
- 解析器必须确定性，不依赖 AI
- 未确认的推断不保存

Risks:
- Markdown 方言差异

## Phase 1: 数据模型
Goal: 引入 Project Plan schema 与三张表
Acceptance:
- 旧 version-1 文件可打开
- 新表初始为空
Next: 补 schema 与表

## Phase 2: API 与导入
Goal: 提供 plan.* 端点与 Markdown 导入
Depends on:
- 1
Acceptance:
- plan.import.preview 不写存储
Decisions:
- 所有写走 applyChange
Result: B1/B2 已完成

### Phase 2: 预览器
Goal: 解析 Markdown 计划
Depends on:
- Phase 2
Context:
- 只解析开发者提供的文本
Next: 写 parsePlanMarkdown

```js
const ignored = true
```

| 表格 | 无法识别 |
| --- | --- |
