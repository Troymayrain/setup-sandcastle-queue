# setup-sandcastle-queue 1.0.0

> 发布状态：尚未发布。本文是 `1.0.0` 候选 release notes；只有 credentialless CI、remote doctor、live E2E、legacy lifecycle dogfood、三票 Batch dogfood 和四分发物一致性 gate 全部绑定同一候选 commit 并成功后，才可将其作为正式发布说明。

## 支持边界

- 支持 GitHub.com repository 与 GitHub Actions，以新的父 PRD 启动最多三票一轮的 dependency-aware Batch。
- 支持 Node/npm、Python/pip、Python/uv、Go module、Java 21/Maven、composite 与显式 custom runtime adapter。
- 支持 deterministic install plan、显式 `planHash` 确认、managed upgrade、legacy adopt、exact-package rollback 与保守 uninstall。
- 支持 credential broker、egress allowlist、protected control-plane paths、remote doctor、checkpoint/continuation、publication reconciliation、cumulative Final Review/Fix 与 sanitized audit。
- 控制面固定为 Node.js `22.22.2`、Claude Code `2.1.217` 和 immutable `linux/amd64` GHCR digest。

## 已知限制

- 当前候选源码中的 managed workflow 仍调用尚未实现的 `sandcastle-queue workflow-host`，所以真实 Batch、remote doctor、live E2E 与 dogfood workflow 会 fail closed。这个 release blocker 未修复前不得发布 `1.0.0`。
- 只支持 GitHub.com；不支持 GitHub Enterprise Server、自托管 runner 或非 `linux/amd64` 控制面镜像。
- lifecycle 命令只能生成当前精确 CLI package 携带的 release，不解析 floating tag，也不自动 merge managed drift。
- 安装器不会替目标仓库执行 `commit`、`push`、`stash` 或 `reset`；GitHub resources 与最终 release 仍需 maintainer 人工授权。

## 安全模型

- 普通 Ticket sandbox 不接收 GitHub token 或长期 provider token；短期 session credential 由 host-side broker 按能力和预算签发。
- workflow permissions 按 operation 最小化，安装器与 Ticket 都不能修改 protected control-plane paths。
- provider egress 通过显式 host allowlist，审计只保存受限 IDs、hashes、timing 与 outcome，不保存 raw transcript、provider body、完整环境变量或 secrets。
- npm package、GitHub Release、skill snapshot 与 GHCR image 必须共享同一 `1.0.0` tag、source manifest、checksums 与 image digest。

## 从 0.1.x 升级

1. 保留 `.sandcastle/config.json`、`.sandcastle/installation.json`、audit history 和当前 Batch 状态；先让 queued/running workflow 到达静止边界。
2. 使用精确的 `setup-sandcastle-queue@1.0.0` package 运行 `doctor --offline`，再执行 `upgrade --target 1.0.0` 生成 preview。
3. 审阅完整 patch、managed drift conflicts、runtime wrapper 与 config migration，只对同一份 plan 传入其 `planHash`。
4. 应用后运行 local doctor 与 remote doctor，再由人工 enrollment 启动新 Batch。任何 drift、stale plan 或 doctor failure 都应停止升级并进入人工处理。
5. 如需恢复到 `0.1.x`，使用目标 `0.1.x` 的精确 CLI package 生成并确认 rollback plan；不要手工覆盖 managed assets。
