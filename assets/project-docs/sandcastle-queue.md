# Sandcastle Queue Agent Guide

本文件由 setup 流程创建，创建后归项目所有；installer upgrade 不会覆盖本地修改。

## 当前运行边界

Queue 配置位于 `.sandcastle/config.json`。runtime engineering skills 位于 `.agents/skills/`，来源与 hash 记录在 `skills-lock.json`。managed workflow 通过 `sandcastle-queue workflow-host` 路由所有 host operation。不要手工替换 dispatcher，也不要把本地合同测试写成 remote-doctor、live E2E 或 release gate 已通过。

本地改动后运行：

```bash
sandcastle-queue validate-config --config .sandcastle/config.json
sandcastle-queue doctor --offline
```

## Queue 语义

- `Batch` 是一个父 PRD 下的一次交付，拥有稳定 ID、branch、draft PR 和 audit timeline。
- `Ticket` 必须在正文唯一 `## Parent` 中指向父 PRD。
- `Frontier` 只包含 open、同时具备 ready/ownership labels、无 assignee、无 native blocker 的 Tickets。
- `Continuation Run` 沿用 Batch，重新读取 GitHub state，并校验 expected HEAD 与 resolved environment hash。
- `Published Commit` 由 host 创建和 atomic push；sandbox commits 不是发布事实。
- `Final Review` 同时检查 Standards 与 Spec，两轴都无 actionable finding 才能把 PR 标记 ready。
- zero diff 进入 `waiting-no-change`，需要人工 accept；abort 默认保留 branch 和 audit evidence。`complete-no-change`、completed abort 或 merged PR 的人工 `finalize-batch` 会按 expected HEAD 释放 active Batch。

## 安全边界

Sandcastle host 负责 GitHub 凭据、provider credential broker、发布、issue 状态和 audit。sandbox 只拿单 session token，不拿 GitHub token 或长期 provider token。sandbox network 只允许 adapter registries 与 config 中的 exact hosts，不允许 wildcard、IP、host network、privileged container 或 Docker socket。

Ticket Agent 不得修改 protected paths：

- `.github/workflows/sandcastle.yml`
- `.github/actions/sandcastle/`
- `.sandcastle/`
- `skills-lock.json`
- `.agents/skills/code-review/`
- `.agents/skills/implement/`
- `.agents/skills/tdd/`
- `.agents/skills/sandcastle-runtime/`

GitHub 副作用按 operation permissions 由 host 执行。sandbox 不能 push、close issue、update PR、dispatch continuation 或 publish audit。

## Runtime 与完成条件

内置 adapters 为 `python-pip`、`python-uv`、`node-npm`、`go-module` 和 `java-maven`；mixed repository 使用有固定顺序的 `composite`，复杂项目使用 schema v1 `custom`。runtime、package manager、lockfile、Maven Wrapper 和 direct dependencies 必须精确锁定。

adapter 负责 bootstrap。Ticket 结束后，host 重新执行 `.sandcastle/config.json` 中的全部 `tests` 和 `verification`，然后检查 protected paths、spec hash 和 fixed-point review。不要把 Agent 文本中的“已测试”当作 host evidence。

## 恢复提示

push 后、closure 前中断时，以 remote reachable Published Commit 做 reconciliation，不重复实现 Ticket。`environment-drift` 要求恢复 lock/runtime identity 后重新 bootstrap；`needs-human-fix` 只允许线性 human fix 后完整 review-only；`needs-base-resolution` 只允许精确双 parent 的 audited base merge；`base-moving` 与 `needs-reconcile` 需要维护者停下自动处理并检查 commit graph。

audit comment 与 sanitized artifact 可以记录 Session、skills、HEAD、runtime hashes、commit、issue、PR、timing 和 outcome，不得保存 raw transcript、prompt/response、token、完整环境变量或完整命令输出。
