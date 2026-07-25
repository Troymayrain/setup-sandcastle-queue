# Sandcastle Queue Setup

本项目定义并分发一套可复用的 Sandcastle GitHub Issues 队列安装配置。上游 Sandcastle 负责 Agent 执行，本项目只负责把队列能力安装到目标仓库。

## Language

**Sandcastle Queue Setup**:
基于上游 `@ai-hero/sandcastle` 的安装与配置分发工具；它不拥有 Agent 执行、sandbox、worktree 或 provider runtime。
_Avoid_: Sandcastle runtime, control plane

**Queue Template**:
由 Sandcastle Queue Setup 安装到目标仓库的版本化队列编排、GitHub Actions 和项目适配配置。
_Avoid_: 内置 runtime, 自研 Sandcastle

**Project-controlled Asset**:
Queue Template 生成后由目标项目自主审阅、修改、删除和维护的资产；Sandcastle Queue Setup 对目标副本没有持续写入权或期望状态权威。项目控制描述维护与变更边界，不表示版权转让，原许可证与第三方归属仍然适用。
_Avoid_: managed asset, Setup-owned file, copyright transfer

**Upstream Sandcastle**:
`@ai-hero/sandcastle` 提供的 Agent 执行、sandbox、worktree 和 provider runtime。
_Avoid_: Queue Template, Setup runtime

**Continuation Run**:
当前 GitHub Actions run 达到票数或时间边界后自动触发的后继 run；它从远端集成分支和 Issues 状态继续同一条队列执行链。
_Avoid_: 长驻 runner, 人工续跑, Batch checkpoint

**Integration Branch**:
首次队列 workflow 从所选 base branch 创建、并由全部 Continuation Runs 共同推进的稳定远端分支。
_Avoid_: Sandcastle 临时分支, runner worktree
