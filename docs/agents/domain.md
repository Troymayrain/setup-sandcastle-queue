# Domain Docs

以下规则说明工程技能在探索代码库时应如何读取本仓库的领域文档。

## 探索前读取

- 仓库根目录的 **`CONTEXT.md`**。
- 如果根目录存在 **`CONTEXT-MAP.md`**，它会指向各 context 的 `CONTEXT.md`；读取与当前主题相关的文件。
- **`docs/adr/`** 中与即将处理区域相关的 ADR。对于 multi-context 仓库，还应检查 `src/<context>/docs/adr/` 中 context-scoped decisions。

如果这些文件不存在，**静默继续**。不要提示缺失，也不要预先建议创建。`/domain-modeling` 技能（可由 `/grill-with-docs` 和 `/improve-codebase-architecture` 进入）会在术语或决策实际明确后按需创建它们。

## 文件结构

本仓库采用 single-context 布局：

```text
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

## 使用 glossary 中的词汇

当输出内容提及某个 domain concept（例如 issue 标题、重构提案、hypothesis 或测试名称）时，使用 `CONTEXT.md` 定义的术语，不要改用 glossary 明确避免的同义词。

如果 glossary 尚未包含所需概念，这通常意味着正在引入项目未使用的语言（应重新考虑），或确实存在术语缺口（记录并交由 `/domain-modeling` 处理）。

## 标记 ADR 冲突

如果输出与现有 ADR 冲突，应明确指出，而不是静默覆盖：

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
