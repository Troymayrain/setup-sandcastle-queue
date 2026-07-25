# 课程管理平台 Queue 行为基线

## 研究问题

课程管理平台现有 `.sandcastle/` 与 GitHub Actions 中，哪些行为是已经验证且应推广的通用机制，哪些是课程项目、当前模型或本机环境专属细节？

## 结论

课程项目已经验证的核心不是一套新的 Sandcastle runtime，而是一层很薄的 Queue orchestration：

1. GitHub Issues 是队列与恢复事实源；
2. 每张 Ticket 都创建全新的上游 Sandcastle `run()`；
3. integration branch 上的 completion commit 是发布事实；
4. host orchestrator 负责写 GitHub，Agent 只持有独立只读凭据；
5. 队列清空后，以固定 base 对累计 diff 做独立 review，并至多进入一次 fix 阶段；
6. 所有不确定状态都 fail closed。

这些机制应进入 Queue Template。课程领域、Django/Python 安装命令、根 `package.json`、固定 Claude 模型、固定分支和 PR 文案不应进入通用模板。当前实现还没有自动 continuation、Actions 内自动创建 integration branch、base drift 收尾验证或 fix 后独立复审；它们不能被表述为“课程项目已验证”，需要由后续设计补齐。

## 证据边界

- 本地源码固定点：`course-manage-platform@b71d7f4fae6ae81591c825f4ff5339073d4fc211`。
- 源码、测试和 Git 历史是机制证据；GitHub Actions runs、Issue completion comments 和已合并 PR 是真实运行证据。
- 2026-07-25 在该固定点重新执行 `npm run sandcastle:check` 与 `npm run sandcastle:test`，类型检查通过，40 个 orchestration/security/audit tests 全部通过。
- CodeGraph 未在课程仓库初始化，因此本研究直接读取了固定 commit 的源码与 Git 历史。

## 已被真实运行验证的端到端行为

### 第一批

- [Run 29713235420](https://github.com/Troymayrain/course-manage-platform/actions/runs/29713235420) 先完成 Ticket 2、3 并逐票 push、关闭；随后因 Ticket 3 仍出现在 frontier 而 fail closed。该次失败保留了已经发布的远端进度。
- [Run 29718455530](https://github.com/Troymayrain/course-manage-platform/actions/runs/29718455530) 从远端现状继续，依次完成 Ticket 4、5、6，执行累计 final review/fix，创建 [PR「Implement course management platform MVP」](https://github.com/Troymayrain/course-manage-platform/pull/7)。该 PR 后续已合并。整个 job 约 5 小时 5 分。
- 这证明恢复不需要自建 Batch 数据库：integration branch、open/closed Issues 和 completion commits 足以让后续 run 继续。

### 第二批

- [Run 29846090836](https://github.com/Troymayrain/course-manage-platform/actions/runs/29846090836) 在解析 review base 时失败，未启动 Agent，并仍生成脱敏审计摘要；后续历史提交 `5719920` 删除了重复的 base ref 获取。
- [Run 29847272539](https://github.com/Troymayrain/course-manage-platform/actions/runs/29847272539) 激活了 4 张 Ticket，但 GitHub label-filtered index 尚未可见，旧实现把 frontier 误判为空。历史提交 [`d505b6f`](https://github.com/Troymayrain/course-manage-platform/commit/d505b6fb6a3f7f9c8ed9593939b308d488782edc) 因此加入 read-after-write 可见性确认与退避。
- [Run 29850250475](https://github.com/Troymayrain/course-manage-platform/actions/runs/29850250475) 识别上述 4 张 Ticket 已激活，依次完成 Ticket 9、10、11、12，执行累计 final review/fix，创建 [PR「Implement course management platform MVP」](https://github.com/Troymayrain/course-manage-platform/pull/13)。该 PR 后续已合并。整个 job 约 4 小时 57 分。

这两批共留下 9 个带 `SANDCASTLE: #<issue>` 前缀的 completion commits 和对应 Issue completion comments。真实运行支持“逐票发布、失败后从远端事实恢复、队列清空后累计审查”这条基线；不支持“单个 run 可以可靠容纳几十张 Ticket”的推断。

## 应进入 Queue Template 的通用机制

### 1. Ticket activation contract

模板必须：

- 只选择 open、无 assignee、非 PR、带 ready label 的 Issues；
- 要求正文各有且仅有一个非空的 `## What to build`、`## Acceptance criteria`、`## Blocked by`；
- 要求 acceptance criteria 至少有一个未勾选项；
- 幂等添加 queue ownership label，labels 名称可配置；
- 完整分页读取，批量写 label；
- 写后使用与 frontier 相同的 label-filtered 查询确认可见；短暂不一致时退避，持续不可见时停止，不能把它当作空队列。

实现证据：

- [activation contract 与幂等激活](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/activate-tickets.mts#L112-L185)
- [分页、分批写入与 visibility gate](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/activate-tickets.mts#L195-L349)
- [activation tests](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/tests/activate-tickets.test.mts)

`## Blocked by` 在 activation 阶段只是正文完整性要求；真正的可执行依赖 gate 来自 GitHub native dependency summary，模板不应自行解析正文里的 Issue 引用作为 canonical dependency graph。

### 2. Frontier selection

模板必须：

- 只接受 open、无 assignee、非 PR、具有 queue label 且 `issue_dependencies_summary.blocked_by === 0` 的 Ticket；
- 对 label 列表候选逐张重新读取最新 Issue，不能信任可能陈旧的列表快照；
- dependency summary 缺失时 fail closed；
- 使用确定性顺序；课程项目按 Issue number 升序，首版可以沿用。

证据：[frontier readiness、revalidation 与排序](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/frontier.mts#L27-L46)。

### 3. 每票一个上游 Sandcastle run

模板必须：

- 每次只把一张明确 Ticket 交给 Agent；
- 每张 Ticket 新建一个 `@ai-hero/sandcastle` `run()`，使用上游 sandbox、Agent provider 与 branch strategy；
- 固定该票开始前的 base SHA，并把可信 repository identity、Issue number 和 base SHA 作为 prompt args；
- 使用 `merge-to-head` 把该票结果并回 integration branch；
- 禁止编排器自行实现 sandbox、worktree 或 Agent runtime。

证据：[直接调用上游 `run()`](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/main.mts#L91-L130)。

### 4. Ticket 完成与幂等恢复协议

模板必须：

- 成功 Ticket 必须产生新 commit，且存在 `SANDCASTLE: #<issue> ` completion marker；
- preserved dirty worktree、零 commit、marker 缺失均 fail closed；
- Agent 报告 blocked 时不得同时产生 commit；host 只评论并停止，不关闭 Ticket；
- 先原子 push integration branch，成功后再关闭 Issue；
- 重跑时如 integration branch 已有 completion marker，则不重复调用 Agent，只重试 push 与关闭 Issue；
- 每票后重新读取 frontier；同一票仍在 frontier 时停止，避免无限循环。

证据：

- [completion marker、blocked 与 push-before-close](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/main.mts#L40-L89)
- [完成结果校验与发布](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/main.mts#L132-L207)
- [逐票后停滞检测](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/drain.mts#L86-L107)

### 5. 固定点累计 review/fix

模板必须保留的基线：

- 队列清空前不做整批 final review；
- 以队列初始 base SHA 对累计 diff 做独立、只读、全新 Agent session；
- review sandbox 产生 commit 或残留 worktree 时 fail closed；
- 有 actionable findings 时才启动另一个全新 fix session；
- fix 状态必须是受约束输出，并与是否产生 commit 一致；
- fix 成功后 push integration branch。

证据：[只读 review 与独立 fix](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/review.mts#L25-L187)。

课程项目当前没有在 fix 后由编排器启动第二个独立 review session；只是在 fix prompt 内要求 Agent 自行调用 `/code-review`。因此“fix 后独立复审一次”属于新模板应补的行为，而不是可直接复制的现状。

### 6. 凭据与信任边界

模板必须：

- host orchestrator 使用可写 `github.token` 处理 label、push、close 和 PR；
- Agent 必须显式取得独立的只读 `SANDCASTLE_AGENT_GH_TOKEN`，不得回退到 host token，也不得与 host token 相同；
- checkout 使用 `persist-credentials: false`；
- GitHub repository identity 由无凭据 HTTPS push URL 验证，并在 Actions 中绑定 `GITHUB_REPOSITORY`；
- host push token 只通过子进程级 Git extraheader 注入，不写 remote 或共享 Git config；
- 传入 Agent 的 provider 环境使用 allowlist。

证据：

- [host/Agent token 分离](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/agent-credentials.mts)
- [可信 repository 与 push 认证](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/git-auth.mts)
- [workflow checkout 与权限](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.github/workflows/sandcastle.yml#L22-L49)

### 7. 轻量、脱敏的运行审计

模板应：

- 按 Ticket、final review、final fix 记录 session ID、run status、base/head SHA；
- 只记录关心的 Skill tool result 状态，不保存 prompt、参数、response 或完整 tool output；
- 原始 verbose JSONL 只用于临时解析，权限设为 `0600`，解析后删除；
- `if: always()` 生成 Summary 并上传 allowlist JSON/Markdown artifact；
- 没有 typed record 时仍生成不含敏感信息的 fallback summary。

证据：

- [raw stream 清理与 allowlist record](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/audit-log.mts#L145-L231)
- [Actions 始终发布脱敏 artifact](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.github/workflows/sandcastle.yml#L139-L164)

审计的“机制”通用；`tdd`、`code-review` 两个具体 skill 名称属于当前团队开发协议。若首版产品已经锁定这两个技能，可作为默认值，但实现不应耦合课程领域。

### 8. Workflow 安全护栏

模板应：

- 对输入、secrets、branch names 和 integration/base 不同做启动前校验；
- 在启动 Agent 前运行 Queue Template 自身 typecheck/tests 并构建 sandbox image；
- 使用仓库级 concurrency，`cancel-in-progress: false`，防止两条 queue chain 并发写同一仓库；
- PR 查找和创建始终显式绑定可信 repository、head 与 base；
- 无累计 diff 时不创建 PR。

证据：[workflow preflight、concurrency 与 PR publication](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.github/workflows/sandcastle.yml#L22-L199)。

## 必须参数化或移除的专属内容

| 当前内容 | 分类 | Queue Template 处理 |
| --- | --- | --- |
| `course-platform-worker`、课程目录 prompt、Django HTTP/TDD 约束 | 课程项目专属 | 使用通用 prompt 骨架；项目上下文从目标仓库文档与 Ticket 读取 |
| `npm install` + `pip install -r requirements.txt` | 项目技术栈专属 | 改为 `bootstrapCommands` |
| `python3`、`sqlite3`、`pip` 写死在 Dockerfile | 项目技术栈专属 | Docker 基础只保留 Agent/Sandcastle 必需项；项目工具由配置或自定义 Dockerfile 扩展 |
| `copyToWorktree: ["node_modules"]` | Node 项目优化 | 改为 `copyToWorktree` 配置 |
| `python manage.py test`、CSS build 等检查 | 课程项目专属 | 改为 `testCommands` / `verificationCommands` |
| `main`、`sandcastle/mvp` | 仓库专属默认 | base branch 由 GitHub/default branch 解析；integration prefix 可配置 |
| `Implement course management platform MVP` | 课程项目文案 | PR title/body 使用通用模板并允许覆盖 |
| `gpt-5.6-sol`、`effort: max` 与整组 `ANTHROPIC_*` 映射 | 当前模型/代理环境专属 | provider/model/env 走受校验配置；保留 allowlist 机制，不复制这些值 |
| `ANTHROPIC_BASE_URL` 必填 | 当前 provider 部署专属 | 只在所选 provider 需要时验证 |
| 根 `package.json` 中的 Sandcastle scripts/dependencies | 当前项目安装形态 | 移入独立 `.sandcastle/package.json` 与 lockfile，不污染应用根依赖 |
| 本地 `.sandcastle/.env` 回退 | 本机调试便利 | 可保留为被忽略的本地入口，但 Actions 只读 repository secrets |
| `npm run sandcastle:prepare-actions` | 当前人工启动流程 | 新模板由首次 workflow run 自动创建 integration branch，不要求本地准备 |

根依赖耦合的直接证据：[课程项目 `package.json`](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/package.json#L8-L35)。运行时硬编码的直接证据：[课程项目 `runtime.mts`](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/runtime.mts#L79-L106)。

## 不应原样继承的现状与缺口

1. **单 run 排空。** 当前 `drain.mts` 达到 `SANDCASTLE_MAX_TICKETS` 后以失败退出，没有自动触发 continuation；workflow 也只有人工 `workflow_dispatch`。模板需要把“有界 run 后自动接力”作为新能力。
2. **伪长 timeout。** workflow 写了 `timeout-minutes: 4320`，但真实成功证据都在约 5 小时内，不能据此声称长队列已验证。模板应在内部时间预算前停止接新 Ticket、保存远端事实并自动 dispatch 后继 run。
3. **人工创建 integration branch。** 当前 workflow 要求调用者传入已存在的 branch，且另有本地 `prepare-actions`。模板应由首次 run 从 base HEAD create-only 创建唯一 branch，后继 run 复用。
4. **没有 continuation 防重协议。** 当前 concurrency 只能串行化 runs，不能证明 dispatch 唯一性。模板还需要 chain identity、expected integration HEAD、最大 continuation 次数和幂等 dispatch gate。
5. **审计只覆盖单 run。** 当前 artifact 不跨 run 聚合。自动接力后，每个 run 仍可保持独立脱敏 artifact；最终 summary 如需全链视图，应从 GitHub/branch 事实汇总，不能引入持久化控制平面。
6. **PR 只在 workflow 末尾创建。** 当前实现完成整个 run 后才创建普通 PR。若目标行为是首票后创建 draft PR、队列与复审完成后再 ready，需要调整 workflow。
7. **没有 base drift 收尾。** 当前只在启动时取 `merge-base`，队列期间不处理 base 更新。新模板需要在最终 ready 前对最新 base 做一次安全试合并与全量验证。
8. **fix 后没有独立复审。** 当前 fix prompt 内部要求 `/code-review`，但 orchestration 没有再启动新的只读 review run。新模板应补一次独立复审，并在仍有 finding 时保留 draft PR、停止。
9. **工作流预检依赖应用根 npm。** `npm ci`、cache 与 scripts 都指向根项目。独立 `.sandcastle` 工具子项目后，workflow 必须把工具依赖和应用 bootstrap 分开。

## 建议进入 Queue Template 的行为清单

以下清单可以作为后续设计/实现规格的行为骨架：

- [ ] 首次 `workflow_dispatch` 从最新 base HEAD create-only 创建唯一 integration branch。
- [ ] 激活满足 Ticket contract 的 Issues；labels 可配置，GitHub native dependencies 是唯一 blocking gate。
- [ ] activation 写后等待 queue label 对消费查询可见，持续不一致则 fail closed。
- [ ] frontier 对每个候选重新读取最新状态，按 Issue number 确定性选第一张。
- [ ] 每票启动全新的上游 Sandcastle `run()`；sandbox、worktree、Agent 生命周期完全交给上游。
- [ ] 项目适配仅通过 `bootstrapCommands`、`testCommands`、`verificationCommands`、`copyToWorktree`。
- [ ] Agent 只做一票；必须留下规定 completion commit，或在零改动状态报告 blocked。
- [ ] host 先原子 push，再关闭 Issue；已存在 completion commit 时只补做发布/关闭。
- [ ] 每票后重新读取远端 frontier；停滞、状态缺失或结果矛盾均停止。
- [ ] host 写 token 与 Agent 只读 token 强制隔离；repository identity、Git remote、provider env 使用 allowlist 验证。
- [ ] 每个 workflow run 使用数量和时间双预算；正常耗尽预算时自动 dispatch 后继 run，不标记整条 queue 失败。
- [ ] 后继 run 只从 integration branch、Issues 和显式 continuation inputs 恢复；不依赖 runner 磁盘或自建 Batch store。
- [ ] repository concurrency + expected HEAD + continuation 上限共同防止并发、重复和无限接力。
- [ ] 第一票成功后创建/复用 draft PR；正常 continuation 只更新同一分支和 PR。
- [ ] queue 清空后针对固定 base 做独立只读 cumulative review，最多一次独立 fix，再独立复审一次。
- [ ] 最终 ready 前用最新 base 做安全试合并、全量项目验证和 final review；冲突或失败时保留 draft PR。
- [ ] 每个 scope 只上传脱敏 audit JSON/summary；原始 Agent stream 解析后删除。
- [ ] 所有课程领域、Django/Python、模型、分支名和 PR 文案均不得硬编码进通用 core。
- [ ] `@ai-hero/sandcastle`、`tsx` 与 Queue Template 工具依赖精确锁定在独立 `.sandcastle/package.json`/lockfile。

## 历史给出的设计警示

课程项目的 Git 历史本身说明“薄层”仍需克制：

- [`b13132d`](https://github.com/Troymayrain/course-manage-platform/commit/b13132dbfd7d34e14972cd4f6bf6cf3c4e2b4c87) 一度加入约 1.1 万行复杂审计、证据链、隔离与状态实现；
- 紧接着 [`7b5d3f8`](https://github.com/Troymayrain/course-manage-platform/commit/7b5d3f897ceb45d949d1f9f78325c8034bf5d34d) 删除约 1.1 万行，恢复成只回答 session 与 Skill 调用状态的轻量审计；
- 后续真正提升可靠性的改动都很局部：frontier revalidation、ticket activation、label visibility gate、可信 GitHub 身份和 create-only branch。

因此 Queue Template 应复制这些经过故障反馈收敛出的“小而硬”机制，不应复制曾经被删除的 control-plane 复杂度。

## 决策摘要

**进入模板：** GitHub Issues/branch 作为事实源、契约化 activation、native dependency frontier、逐票 fresh upstream `run()`、completion commit 幂等发布、凭据隔离、累计 review/fix、轻量脱敏审计、fail-closed 护栏。

**参数化：** 项目命令、worktree copy、sandbox 扩展、provider/model/env、labels、base/integration branch、prompt、PR 文案。

**移除：** 课程/Django/Python 硬编码、根 npm 依赖污染、本地 prepare-actions 作为必经入口、固定模型/endpoint、当前人工多 run 流程。

**新增但不得伪称已验证：** GitHub-hosted runner 自动 continuation、Actions 内自动创建 integration branch、draft PR 生命周期、expected-HEAD 防重、最新 base 收尾验证、fix 后独立复审。
