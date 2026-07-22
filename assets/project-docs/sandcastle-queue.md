# Sandcastle Queue Agent Guide

本文件由 setup 流程创建，创建后归项目所有；installer upgrade 不会覆盖本地修改。

- Queue 配置位于 `.sandcastle/config.json`。
- runtime engineering skills 位于 `.agents/skills/`，其来源与 hash 记录在 `skills-lock.json`。
- Sandcastle host 负责 GitHub 凭据、发布、issue 状态和审计；sandbox Agent 不执行 commit、push 或 tracker 写入。
- 修改 tests、verification、runtime 或 custom adapter 前，先运行 local doctor。
