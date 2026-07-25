# Issue tracker: GitHub

本仓库的 issues 与 PRDs 存放在 GitHub Issues 中。所有操作均使用 `gh` CLI。

## 约定

- **创建 issue**：`gh issue create --title "..." --body "..."`。多行正文使用 heredoc。
- **读取 issue**：`gh issue view <number> --comments`，使用 `jq` 筛选评论，并同时获取 labels。
- **列出 issues**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，并按需使用 `--label` 与 `--state` 筛选。
- **评论 issue**：`gh issue comment <number> --body "..."`
- **添加或移除 labels**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭 issue**：`gh issue close <number> --comment "..."`

仓库由 `git remote -v` 推断；在 clone 内运行时，`gh` 会自动完成此操作。

## Pull requests as a triage surface

**PRs as a request surface: no.** _(如果本仓库将外部 PR 视为功能请求，可设为 `yes`；`/triage` 会读取此标记。)_

设为 `yes` 后，PR 将通过与 issues 相同的 labels 和状态流转，并使用对应的 `gh pr` 命令：

- **读取 PR**：`gh pr view <number> --comments`；使用 `gh pr diff <number>` 查看 diff。
- **列出待 triage 的外部 PR**：运行 `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，仅保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的结果，排除 `OWNER`、`MEMBER` 与 `COLLABORATOR`。
- **评论、添加 label 或关闭**：`gh pr comment`、`gh pr edit --add-label` / `--remove-label`、`gh pr close`。

GitHub 的 issues 与 PRs 共用编号空间，因此单独出现的 `#42` 可能指向任意一种对象。先运行 `gh pr view 42`，失败后再运行 `gh issue view 42`。

## 当技能要求“publish to the issue tracker”

创建一个 GitHub issue。

## 当技能要求“fetch the relevant ticket”

运行 `gh issue view <number> --comments`。

## Wayfinding 操作

供 `/wayfinder` 使用。**Map** 是一个 issue，其 **child** issues 作为 tickets。

- **Map**：带有 `wayfinder:map` label 的单个 issue，正文包含 Notes / Decisions-so-far / Fog。使用 `gh issue create --label wayfinder:map` 创建。
- **Child ticket**：通过 GitHub sub-issue 关联到 map（使用 sub-issues endpoint 的 `gh api`）。如果 sub-issues 未启用，则把 child 加入 map 正文的任务列表，并在 child 正文顶部加入 `Part of #<map>`。Labels 使用 `wayfinder:<type>`，其中 `<type>` 为 `research`、`prototype`、`grilling` 或 `task`。Ticket 被认领后，分配给负责推进的开发者。
- **Blocking**：使用 GitHub 原生 issue dependencies 作为 canonical、UI 可见的表示。通过 `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` 添加依赖边；`<blocker-db-id>` 是 blocker 的数字型数据库 **id**，通过 `gh api repos/<owner>/<repo>/issues/<n> --jq .id` 获取，而不是 `#number` 或 `node_id`。GitHub 的 `issue_dependencies_summary.blocked_by` 仅报告仍打开的 blockers，是实时 gate。如果 dependencies 不可用，则在 child 正文顶部加入 `Blocked by: #<n>, #<n>`。所有 blockers 关闭后，ticket 才视为 unblocked。
- **Frontier query**：列出 map 中仍打开的 children（使用 `gh issue list --state open`，范围限定为 map 的 sub-issues 或任务列表），排除存在打开 blocker（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行中仍有打开的 issue）或已有 assignee 的项目；按 map 中的顺序选择第一个。
- **Claim**：`gh issue edit <n> --add-assignee @me`，这是 session 的第一次写操作。
- **Resolve**：运行 `gh issue comment <n> --body "<answer>"`，随后运行 `gh issue close <n>`，最后向 map 的 Decisions-so-far 追加 context pointer（gist + link）。
