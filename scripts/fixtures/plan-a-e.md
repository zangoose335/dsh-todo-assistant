# 待办助理扩展路线图

把待办助理从基础卡片扩展到计划、维护、拖拽和步骤；每个阶段都要能单独交接。

Decisions:
- 先做确定性能力，AI 辅助只做增强

Risks:
- 阶段太多时交接材料会变长

## Phase A: 历史补全
Goal: 让来源与按需回读可用
Acceptance:
- 多来源可用
- 旧卡兼容
Next: 完成 A 阶段

## Phase B: 计划模型
Goal: 项目、阶段、依赖与交接
Depends on:
- A
Acceptance:
- 旧文件可打开
- 阶段能拆分
Next: 做 B 阶段
### Phase B1: 数据与接口
Goal: 模型、存储、导入
Depends on:
- B
### Phase B2: 页面与交接
Goal: 计划页面
Depends on:
- B1

## Phase C: 计划维护
Goal: 结果、变更与提议
Depends on:
- B

## Phase D: 拖拽交接
Goal: 卡片与阶段拖到输入框
Depends on:
- B2

## Phase E: 卡片步骤
Goal: 卡片内的步骤
Depends on:
- B
