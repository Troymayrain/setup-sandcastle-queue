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

**Processing Run**:
只处理一张 Ticket 的有界 GitHub Actions run；首次 Processing Run 由维护者人工触发，后续工作通过 Continuation Run 接力。
_Avoid_: Ticket Run, 多 Ticket 单次 run

**Ticket Deadline**:
Processing Run 中为当前 Ticket 的 Agent 与项目命令执行预留的截止时间；等于 Queue job hard deadline 减去 Host finalization reserve。到达后取消 Sandcastle，并只从远端 publication facts 判断 complete、absent 或 unknown。
_Avoid_: runner timeout, retry Agent, mutable timer checkpoint

**Integration Branch**:
首次队列 workflow 从所选 base branch 创建、并由全部 Continuation Runs 共同推进的稳定远端分支。
_Avoid_: Sandcastle 临时分支, runner worktree

**Ticket Publication Marker**:
在 completion commit 已 push 并通过远端 HEAD 校验后，为一张 Ticket 创建且不再修改的发布事实；Issue 只有在该 marker 可见后才能关闭。
_Avoid_: mutable checkpoint, Batch state

**Ticket Publication Reconciliation**:
Processing Run 选择新 Ticket 前，从远端 completion commit、Ticket、Ticket Publication Marker 与 Issue 状态唯一证明并补齐中断的 publication；无法唯一证明时停止为 `conflict`。
_Avoid_: rerun Agent, rewrite history, local checkpoint

**Final Review**:
Queue 真正清空后，在临时合并最新 base 的独立 worktree 中运行项目检查和 fresh read-only Sandcastle session；只产生 `pass` 或 `needs-fix` verdict，不修改 Integration Branch。
_Avoid_: Ticket review, Agent self-approval, automatic merge

**Final Review Marker**:
写入唯一 Integration PR 的不可变远端事实，绑定完整 Integration HEAD、base HEAD、verdict 与 run ID；只有可见且唯一的 `pass` marker 才允许把 draft PR 标记为 ready for human review。
_Avoid_: mutable review state, approval, merge authorization

**Final Fix**:
由 first Final Review 的 `needs-fix` marker 对精确 Integration HEAD 授权的唯一自动修复；使用 fresh Sandcastle session 产生一个新 Integration HEAD，发布后不再允许第二次自动修复。
_Avoid_: retry Agent, unbounded repair loop, stale authorization

**Final Fix Marker**:
写入唯一 Integration PR 的不可变远端事实，绑定 first Final Review run、Final Fix run、修复前后完整 Integration HEAD 与 fixing session；其存在表示唯一自动修复授权已消费。
_Avoid_: retry permission, mutable fix state, second fix authorization

**Final Rereview**:
Final Fix 发布后在新 run、fresh read-only session 与最新 base 临时合并上执行的独立复审；`needs-fix` 只交还人工，不再授权 Final Fix。
_Avoid_: fixing Agent self-approval, second automatic fix

**Final Rereview Marker**:
写入唯一 Integration PR 的不可变远端事实，绑定 Final Fix run、Final Rereview run、完整 Integration/base HEAD 与独立复审 verdict。
_Avoid_: Final Review Marker, self-approval, mutable rereview state

**Queue Audit Record**:
每个 workflow-host operation 写入 Job Summary 与短期 artifact 的单条脱敏记录；只包含 allowlisted run、operation、Ticket、session、commit/head、status 与 duration 字段，用于把 Actions run 关联到 GitHub Issues、commits 和 PR markers。它不是恢复状态或长期事实来源。
_Avoid_: raw Agent transcript, complete command output, custom ledger, checkpoint
