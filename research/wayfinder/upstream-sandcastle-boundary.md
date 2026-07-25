# 上游 Sandcastle 的可复用边界

## 研究问题

上游 `@ai-hero/sandcastle` 当前公开 API、`sandcastle init`、templates、sandbox providers 和 branch strategies 中，哪些可以直接支撑已确认的 Queue Setup，哪些能力必须由 Queue Template 外层补充？

## 快照与方法

- 研究日期：2026-07-25。
- 上游源码：`mattpocock/sandcastle` 的 `main`，commit `e99f832f26dc9d245c019a9ddd19fa5dee792427`。
- npm latest：`@ai-hero/sandcastle@0.12.0`；npm metadata 的 `gitHead` 与上述 commit 相同。[npm metadata](https://registry.npmjs.org/@ai-hero%2Fsandcastle/latest) 与 [上游 package.json](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/package.json#L1-L35)。
- 只使用上游 README、源码、ADR、package metadata；以下“必须外层补充”是将这些事实与 Wayfinder map 已锁定的 Queue Setup 目标进行差异分析后的设计结论。

## 决策

Queue Setup 应把上游 Sandcastle 当作 **Agent 执行内核**，而不是当作完整队列产品：

1. 直接依赖并精确锁定 `@ai-hero/sandcastle@0.12.0`，只通过 package exports 暴露的公开入口调用它。
2. 每张 Ticket、final review 和 final fix 都调用上游 `run()`；使用上游 `claudeCode()`、`docker()`、lifecycle hooks、日志/结果和 `merge-to-head` branch strategy。
3. 不重写 Agent provider、sandbox、container lifecycle、worktree、commit collection、prompt expansion 或 session capture。
4. 不把上游 `sandcastle init` 或 stock template 当作 Queue Setup 的模板契约。它们可作为实现参考或 fresh scaffold seed，但 Queue Setup 必须拥有自己的 queue-specific 文件模板、installer 与 GitHub Actions 外层。
5. 不导入 `InitService`、`WorktreeManager` 等内部模块，也不依赖 `dist/...` 私有路径；如果确实调用上游 init，只能调用公开的 `sandcastle init` CLI。

这个边界仍然是“基于 Sandcastle”：真正困难且通用的 Agent/sandbox/git 执行全部交给上游；本项目只实现 Sandcastle 明确不持有的 GitHub Issues 队列政策、跨 workflow 调度和安装体验。

## 可直接复用的能力

### 1. 公开执行 API

package root 公开导出：

- `run()`、`interactive()`、`createSandbox()`、`createWorktree()`；
- `claudeCode()`、`codex()`、`copilot()`、`cursor()`、`opencode()`、`pi()`；
- structured output、stream event、session transfer 和 custom sandbox-provider 类型/工厂。

完整 export surface 见 [src/index.ts](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/index.ts#L1-L100)。首版 Queue Setup 实际只需 `run()`、`claudeCode()` 和 Docker subpath 的 `docker()`；`createSandbox()` 只在未来需要同一容器内多轮交互时才有必要。

`run()` 已经提供 Queue worker 所需的执行原语：

- `cwd`、file/inline prompt、`promptArgs`；
- `maxIterations`、completion signal、idle/completion timeout、`AbortSignal`；
- host/sandbox hooks、`copyToWorktree`；
- branch strategy；
- file/stdout logging 和 stream callback；
- 返回 iterations（含可选 session ID/usage）、stdout、commits、branch、log path 与 preserved worktree。

证据见 [`RunOptions` / `RunResult`](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/run.ts#L332-L460)。因此外层不应再定义自己的 Agent driver 或执行状态机；它只需要把“一张已选定 Ticket”转成一次 `run()` 调用并校验结果。

### 2. Claude Code provider 与凭据注入

`claudeCode(model, options)` 支持 effort、显式 `env`、session capture 和 permission mode，并默认捕获可恢复的 session。[`ClaudeCodeOptions` 与 factory](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L1155-L1204)。

这足以让 Queue Template 把 Agent 专用只读 GitHub token 和 Anthropic-compatible provider 变量传入 sandbox；不需要 credential broker。**但 token 的角色划分、最小权限检查以及哪些变量可以传给 Agent，仍由外层负责**。

另一个重要边界是：上游只会从 `.sandcastle/.env` 解析已声明的键，优先级为该文件值再回退到 `process.env`，而且不读取 repo root `.env`。[EnvResolver](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/EnvResolver.ts#L49-L72)。Actions 中应优先用 `claudeCode(..., { env })` 显式构造 Agent 环境，避免把宿主写 token 混入通用进程环境。

### 3. Docker sandbox 与 lifecycle

Docker 是公开 package subpath；package metadata 还暴露 Podman、Vercel、Daytona 和 no-sandbox subpaths。[package exports](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/package.json#L8-L35)。

首版只需直接复用 `docker()`。它已经处理：

- worktree/git bind mounts；
- image、UID/GID preflight；
- environment、mounts、network、groups、devices 与 CPU options；
- container start/exec/stream/cleanup。

见 [`DockerOptions` 与 `docker()`](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/sandboxes/docker.ts#L37-L188)。所以本项目不应保留自研 sandbox abstraction、Docker lifecycle 或 egress/runtime adapter。

项目的通用 `bootstrapCommands`、`testCommands`、`verificationCommands` 可映射到上游 sandbox hooks 或由 Queue harness 在 run 前后执行；上游 hooks 已是足够的通用接口，不需要按 Python/Node/Go 重建 adapters。

### 4. Branch strategy 与 worktree

上游定义了三种策略：

- `head`：直接写宿主 working directory；
- `merge-to-head`：在临时 worktree/branch 执行，完成后 merge 回当前 HEAD 并删除临时 branch；
- `branch`：在显式命名 branch/worktree 上落 commit，可指定新 branch 的 `baseBranch`。

类型与 `baseBranch` 责任见 [SandboxProvider.ts](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SandboxProvider.ts#L243-L289)。`run()` 对 bind-mount provider 默认使用 `head`、对 isolated provider 默认使用 `merge-to-head`，并禁止 `head + copyToWorktree`。[run.ts](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/run.ts#L507-L532)。

Queue Template 应显式使用 `merge-to-head`：

- Actions checkout 稳定 Integration Branch；
- 每票在 fresh 临时 worktree 中执行；
- 成功后由上游 merge 回 Actions checkout 的 Integration Branch；
- 外层验证 commit marker / clean tree，再 push Integration Branch。

这直接复用了上游 worktree 与 merge 实现，同时避免 `head` 让 Agent 直接写 host checkout。它也比把 Integration Branch 传给 named `branch` 更正确：如果该 branch 已在主 working tree checkout，Git 本身拒绝在另一个 worktree 再 checkout；上游明确检测并报错。[WorktreeManager](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/WorktreeManager.ts#L331-L380)。

named `branch` 适合独立分支 pipeline，但不应承担跨 GitHub-hosted runs 的 continuation 状态。上游对 managed worktree 的复用和 origin fast-forward 是本地磁盘优化，runner 消失后不可依赖；而且 fetch 失败或 branch diverged 时会保留本地状态继续运行。[复用规则](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/WorktreeManager.ts#L195-L275)。Continuation 的恢复事实必须是远端 Integration Branch 与 GitHub Issues，而不是 `.sandcastle/worktrees/`。

### 5. Prompt、日志和结果

上游支持 prompt file 参数替换、sandbox 内 shell expansion、completion signal、structured output、session ID/usage 和 raw stream callback；这些足以构造 Ticket prompt、final-review prompt 与轻量 audit capture。[README RunOptions/RunResult](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L832-L870)。

外层应消费这些输出，但不要再定义自有 Agent wire protocol。脱敏、JSON audit schema、GitHub Summary 与 artifact retention 属于 Queue 产品政策，仍需在外层实现。

## `sandcastle init` 和 stock templates 的边界

### `sandcastle init` 能做什么

公开 CLI 可以交互或 non-interactive 地选择 agent、model、Docker/Podman、GitHub Issues/Beads/custom tracker、五种 template，选择是否创建 `Sandcastle` label、build image 和安装 template dependency。[README init flags](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L750-L800)。

它会生成 `.sandcastle` 中的 containerfile、`.gitignore`、`.env.example` 和 template files，并做 agent/sandbox/tracker substitutions。[scaffold 实现](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/InitService.ts#L1017-L1108)。这意味着它可作为理解上游默认 Dockerfile 和 prompt wiring 的 primary reference。

### 为什么不能直接等同于 Queue Setup

1. `init` 发现 `.sandcastle/` 已存在就直接失败，不提供 Queue Setup 已确认需要的幂等 diff/doctor 语义。[存在性检查](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/InitService.ts#L1031-L1042)。
2. 它检测并可能修改 **host root** package dependency；模板的运行说明也要求向 root `package.json` 添加 script。Queue Setup 已锁定独立 `.sandcastle/package.json` 与 lockfile，所以其依赖所有权模型不同。[package-manager/template dependency 说明](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L766-L784)。
3. 它只 best-effort 创建一个 `Sandcastle` label；没有 Ticket Contract labels、Actions permissions/secrets/variables、workflow、integration branch、PR 或 continuation 配置。[label 创建代码](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/cli.ts#L390-L420)。
4. `InitService`、template registry 和 scaffold function 没有从 package root 或 package subpath 导出；公开 package exports 只有 root 与 sandbox providers。[package exports](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/package.json#L8-L35) 与 [root exports](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/index.ts#L1-L100)。因此不能把上游内部 scaffold functions 当稳定库 API。

结论：Queue Setup 不应 fork/patch `sandcastle init`，也不应导入内部 scaffold。可以在 fresh install 时精确版本调用 `sandcastle init --template blank ...` 再 overlay，但这会立即替换 main、prompt、env、package ownership 和 remote setup，实际复用价值有限。更清晰的首版边界是：Queue Setup 自己生成 queue-specific assets，生成的脚本只调用 Sandcastle 的公开 runtime API；上游 init 保留为参考和独立的通用入门工具。

### stock templates 能做什么、缺什么

上游提供 `blank`、`simple-loop`、`sequential-reviewer`、`parallel-planner`、`parallel-planner-with-review` 五个模板。[模板 registry](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/InitService.ts#L32-L60)。

它们证明了以下组合方式可以复用：

- `simple-loop`：`run() + docker() + merge-to-head + hooks`；
- `sequential-reviewer`：`createSandbox()` 内 implement/review 两阶段；
- planner templates：structured output、named branches、并行 runs 和 merge agent。

但它们不是目标 Queue Contract：

- `simple-loop` 把“选哪张 issue、是否 blocked、何时 close”交给 Agent prompt；只按单一 label 列出 issues，并硬编码 `npm` 验证命令。[prompt](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/simple-loop/prompt.md#L1-L53) 与 [main](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/simple-loop/main.mts#L1-L50)。
- `sequential-reviewer` 每轮创建 timestamp branch，并把 backlog-empty 等同于“Agent 没产生 commit”；没有稳定 Integration Branch、host-side publish/close 或 workflow continuation。[template](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/sequential-reviewer/main.mts#L31-L117)。
- planner templates 是 Agent 规划、并行 branch、Agent merge 模型，与已锁定的 host-deterministic、串行 Ticket 队列不一致。[parallel planner](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/parallel-planner/main.mts#L56-L132)。

因此可复用的是它们展示的 public API pattern，不是文件原样复制。

## Queue Template 最小必须补充什么

以下均是 Queue 产品层，不与上游职责重叠。

### A. 安装与配置分发

- 独立 `.sandcastle/package.json` 和 lockfile，精确锁定上游版本与 `tsx`；
- `.sandcastle/queue.config.json` 的通用 bootstrap/test/verification commands、labels、model、runner/time budget 等配置；
- `init` 的目标仓库检测、完整 diff、明确确认、幂等 no-op/conflict stop；
- 只读 `doctor`；
- queue-specific Dockerfile、prompts、worker scripts、Actions workflow 和 `.env.example`；
- GitHub labels、Actions permissions、secrets/variables 的检查与确认式配置。

### B. 确定性的 Ticket Queue

- 在 **宿主 harness** 解析固定 sections、未完成 acceptance item、ready label、无 assignee 和 `Blocked by`；
- 计算 frontier、activation/ownership label 和严格串行顺序；
- 每票只给 Agent 一个明确 Ticket，不让 Agent 自选 backlog；
- `maxIterations: 1` 的 fresh `run()`、完成 commit marker、expected base/head、clean-tree 和 result validation；
- host 写 token 负责 push、comment、close 与 PR；Agent 只读 token 只进入 `claudeCode({ env })`。

这里的 `maxIterations` 是一次 Sandcastle run 内的 Agent 调用次数，不是 GitHub queue size，也不是 continuation 机制；Queue harness 必须自己维护“每票一次 run”的外循环。

### C. GitHub Actions 控制面

- 首次 `workflow_dispatch` 自动创建 Integration Branch；
- repository concurrency，防止两条 queue chain 并行；
- 有界 ticket count / time budget；
- publish 成功后重新读取远端 branch 与 Issues；
- 有剩余 frontier 时自动触发下一次 workflow，携带 integration/base branch、expected HEAD、continuation count 等最小输入；
- duplicate/stale continuation guard、最大 continuation 次数与异常停止；
- queue 清空后的 final review、最多一次 fix、复审；
- 对最新 base 的临时试合并、测试和 review；
- draft PR 创建/复用与“ready/保留 draft”的政策。

上游只把 commit 合并回本地 HEAD；它不 push branch、不创建/关闭 PR、不 dispatch workflow，也不提供跨 runner checkpoint。这些必须由 Queue Template 控制，但无需演变成通用 Batch runtime。

### D. 审计与发布证据

- 从 `RunResult.iterations[*].sessionId`、base/head SHA、commits、completion status 和 stream observation 生成脱敏 JSON；
- 删除 raw verbose stream，只上传 sanitized artifact 与 GitHub Step Summary；
- fixtures、30-ticket contract tests 和多次真实 continuation dogfood。

## 最小调用形状

Queue worker 的核心应保持接近下面的薄层，而不是再包一套 runtime：

```ts
const baseSha = revParse("HEAD");

const result = await run({
  name: `ticket-${ticket.number}`,
  agent: claudeCode(config.model, {
    effort: config.effort,
    env: buildAgentOnlyEnv(),
  }),
  sandbox: docker({ imageName: config.imageName }),
  promptFile: absolutePromptPath,
  promptArgs: {
    ISSUE_NUMBER: String(ticket.number),
    TICKET_BASE_SHA: baseSha,
  },
  maxIterations: 1,
  branchStrategy: { type: "merge-to-head" },
  hooks: buildProjectHooks(config),
  logging: buildEphemeralAuditCapture(ticket.number),
});

validateTicketResult({ ticket, baseSha, result });
pushIntegrationBranchWithHostCredential();
closeTicketWithHostCredential();
```

frontier、continuation、GitHub publish 和 audit 都围绕这次公开 `run()` 调用存在；它们不替代 `run()` 内部。

## 风险与约束

1. `0.12.0` 仍是 pre-1.0。必须精确版本 + committed lockfile，并在显式升级时运行 contract tests。
2. 不要把上游 source 中 `export` 但 package root 未导出的符号误当公开 API；以 `package.json.exports` 和 `src/index.ts` 的交集为准。
3. `merge-to-head` 会修改本地 checkout，但不会推远端。host push/expected HEAD 是 Queue harness 的责任。
4. `.sandcastle/worktrees/`、logs 与 session files 都是 runner-local；正常 continuation 不得依赖它们。
5. stock templates 的 prompt-driven issue selection 适合示例，不满足确定性 host gate；不要用“让 Agent 判断 ready/blocked”代替 Ticket Contract parser。

## 一句话结论

**直接复用 Sandcastle 的 `run + claudeCode + docker + merge-to-head + hooks/logging/result`；Queue Template 只补“安装、确定性 GitHub Issues 队列、Actions 自动接力、发布/PR、凭据边界和脱敏审计”，不补任何 Agent/sandbox/worktree runtime。**
