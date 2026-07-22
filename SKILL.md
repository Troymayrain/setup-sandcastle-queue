---
name: setup-sandcastle-queue
description: 在 GitHub 仓库中规划、安装与验证 Sandcastle Queue。用户要求 setup、install、preview、resume 或检查 Sandcastle Queue 安装时使用；所有生命周期操作必须委托给仓库内精确版本 CLI。
---

# Setup Sandcastle Queue

只通过 `node scripts/setup.mjs` 调用共享 installer core。不要在 skill 中重写模板、配置校验、diff 或文件应用逻辑。

当前源码中的 managed workflow 仍引用尚未实现的 `sandcastle-queue workflow-host`。本 skill 可以完成本地 plan、install、lifecycle preview 和 doctor，但不得声称真实 Batch、remote-doctor、live E2E 或 release gate 已运行成功。完整边界见 `OPERATIONS.md`。

## 工作流

1. 在目标 Git 仓库中运行 `node <skill-root>/scripts/setup.mjs version`，记录精确 installer SemVer。
2. 运行 `node <skill-root>/scripts/setup.mjs propose`，检查 runtime、tests 与 verification proposal；有歧义时，把维护者确认的 `<adapter>@<exact-version>` 传给 `--confirm-runtime`。
3. 将不含 token 或 Base URL 值的项目配置保存到临时文件，运行 `node <skill-root>/scripts/setup.mjs plan --config <path>`。
4. 向维护者展示完整 patch 与 `planHash`。凭据暂不可用时追加 `--save-pending`；恢复时运行 `plan --resume-pending`。
5. 只有维护者确认同一 `planHash` 后，运行 `node <skill-root>/scripts/setup.mjs install --plan <path> --confirm <planHash>`。
6. 运行 `node <skill-root>/scripts/setup.mjs doctor --offline`，确认 schema、managed hashes、runtime skills、commands 与 workflow contract。
7. GitHub resources 先用 `configure-github --config <path>` 预览；只有维护者确认 `labels,environment,provider-variable,provider-secret` 四类资源后才应用。branch protection、rulesets、PAT/GitHub App、organization policy 与 Environment reviewers 始终交给维护者。
8. 原样报告 CLI 的 JSON、exit status 与诊断；不要通过手工写文件、伪造 artifact 或扩大 workflow permission 绕过失败结果。

## 安装状态

- `fresh` 使用 `install`。
- `managed` 的相同版本 reinstall 应为 zero diff；更新走 `upgrade`，恢复走 `rollback`。
- `unmanaged` 只能在 legacy workflow quiescent 且旧 integration PR 已处理后显式 `adopt`。
- 凭据暂缺时使用 `plan --save-pending`，恢复时使用 `plan --resume-pending`；pending stale 后重新 plan。

`uninstall` 默认保留 project config、project-owned docs、audit history、GitHub resources 与本地修改过的 managed files。

始终保留目标仓库中的 unrelated dirty changes。不要执行 stash、reset、checkout、stage、commit 或 push。
