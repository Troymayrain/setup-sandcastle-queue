# Sandcastle Queue 安全使用与运维手册

这份手册面向第一次接手仓库的维护者。命令示例默认已经构建本仓库，并把 CLI 路径记为 `/path/to/setup-sandcastle-queue/dist/cli.js`。所有命令都应在目标 Git 仓库中运行。

## 当前可用边界

本地 installer、GitHub resource 配置、runtime adapters、sandbox policy、ticket publication、Final Review、audit、credentialless CI、release evidence validators 和 `sandcastle-queue workflow-host` dispatcher 已实现并有合同测试。managed `.github/workflows/sandcastle.yml` 可路由 process、Final Review/Fix、abort、merged Batch finalize、remote doctor，以及 `accept-no-change` 和 `complete-no-change` 两个人工决定。

本地测试不等于远端验收。在候选 commit 的 credentialless gate、remote doctor、live E2E 和 dogfood gate 都取得真实成功证据前，不要把当前候选用于生产 Batch，也不要手工替换 workflow 命令或伪造 evidence 绕过 release gate。

## Quickstart

### 1. 检查工具和目标仓库

```bash
node /path/to/setup-sandcastle-queue/dist/cli.js version
git remote get-url origin
```

CLI 要求 Node.js 22。目标必须是 Git repository，`origin` 必须指向 GitHub.com。installer 可以与无关的 dirty files 共存，但不会 `stash`、`reset`、`checkout`、stage、commit 或 push。

### 2. 检测 runtime

```bash
node /path/to/setup-sandcastle-queue/dist/cli.js propose
```

输出包含 adapter、精确 runtime version、dependency bootstrap、tests 和 verification commands。多个 runtime 同时出现时，检测会返回 `AMBIGUOUS_RUNTIME`；按维护者确认的 adapter 重试：

```bash
node /path/to/setup-sandcastle-queue/dist/cli.js propose \
  --confirm-runtime python-pip@3.12.8
```

mixed repository 应配置 `composite`，不要通过挑一个 adapter 隐藏其余工具链。

### 3. 创建并校验配置

配置必须符合 [`schema/config.schema.json`](./schema/config.schema.json)。下面是 Node/npm 的最小完整示例：

```json
{
  "schemaVersion": 1,
  "queue": {
    "readyLabel": "ready-for-agent",
    "ownershipLabel": "sandcastle"
  },
  "runtime": {
    "adapter": "node-npm",
    "version": "22.22.2"
  },
  "commands": {
    "tests": [{ "argv": ["npm", "test"] }],
    "verification": [{ "argv": ["npm", "run", "typecheck"] }]
  },
  "provider": {
    "kind": "anthropic-compatible",
    "models": { "ticket": "ticket-model" }
  },
  "execution": {
    "jobTimeoutMinutes": 350,
    "processingBudgetMinutes": 300,
    "ticketTimeoutMinutes": 120,
    "minimumRemainingMinutes": 140,
    "maxTicketsPerRun": 3
  },
  "audit": { "retentionDays": 30 }
}
```

```bash
node /path/to/setup-sandcastle-queue/dist/cli.js validate-config \
  --config /tmp/sandcastle-config.json
```

配置只保存静态策略，不保存 token、Base URL 值、repository identity、issue number、branch 或运行状态。

### 4. 预览并应用

```bash
node /path/to/setup-sandcastle-queue/dist/cli.js plan \
  --config /tmp/sandcastle-config.json \
  > /tmp/sandcastle-plan-output.json
jq '.result' /tmp/sandcastle-plan-output.json > /tmp/sandcastle-plan.json
```

检查 `patch`、`assets`、`preconditions`、`installationState` 和 `planHash`。只有同一份 plan 仍符合 HEAD、index 与目标文件 preconditions 时才能应用：

```bash
node /path/to/setup-sandcastle-queue/dist/cli.js install \
  --plan /tmp/sandcastle-plan.json \
  --confirm "$(jq -r '.planHash' /tmp/sandcastle-plan.json)"
```

写入过程是原子的。中途失败会恢复已经触及的 candidate files，不会处理无关文件。

### 5. 凭据暂缺时保存 pending plan

```bash
node /path/to/setup-sandcastle-queue/dist/cli.js plan \
  --config /tmp/sandcastle-config.json \
  --save-pending
node /path/to/setup-sandcastle-queue/dist/cli.js plan --resume-pending
```

pending state 位于 Git directory 的 `sandcastle/pending-plan.json`，不会进入 worktree 或 commit，也不会保存 `ANTHROPIC_AUTH_TOKEN` 与 `ANTHROPIC_BASE_URL`。目标 HEAD、index 或候选内容变化后会返回 `PENDING_PLAN_STALE`，此时重新 plan，不要编辑 pending 文件。

## 安装状态和文件所有权

`fresh` 表示没有 Sandcastle assets，可走普通 install；`managed` 表示存在有效 `.sandcastle/installation.json`，相同版本 reinstall 应得到空 patch；`unmanaged` 表示发现旧 Sandcastle assets 但没有可信 manifest，普通 install 会要求显式 adopt。

installer-managed files 包括 workflow、runtime skill snapshots、skill lock、provenance 和 notices。`.sandcastle/config.json` 与 `docs/agents/sandcastle-queue.md` 创建后归项目所有，upgrade 不覆盖本地修改。`.sandcastle/installation.json` 记录 installer/template version 与 managed hashes，是 doctor、upgrade、rollback 和 uninstall 的判断依据。

## 配置 schema

| Section | 用途 | 关键约束 |
| --- | --- | --- |
| `queue` | ready 与 ownership labels | 两个 label 独立；只有同时满足才可执行 |
| `runtime` | adapter、应用 runtime、工具和额外 hosts | version 必须是精确 SemVer；拒绝 unknown fields |
| `commands` | host 强制执行的 tests 与 verification | `tests` 至少一条；每条使用直接 `argv`，不走 shell |
| `provider` | Anthropic-compatible provider 与 model roles | `ticket` 必填；`finalReview`、`finalFix`、`fast` 可回退 |
| `execution` | job、processing、ticket 和 continuation 限制 | job 不超过 350 分钟，每 run 最多三票 |
| `audit` | 短期 artifact retention | 1 到 90 天 |

`networkHosts` 只接受精确 public DNS hostname，拒绝 wildcard、URL、IP、CIDR、localhost、host network 和 Docker socket。provider Base URL 使用 GitHub Environment variable `ANTHROPIC_BASE_URL`，长期 token 使用 Environment secret `ANTHROPIC_AUTH_TOKEN`。

## GitHub setup

先以只读方式预览 labels、Environment 和高权限设置：

```bash
GITHUB_TOKEN=... \
ANTHROPIC_BASE_URL=https://provider.example.com \
ANTHROPIC_AUTH_TOKEN=... \
node /path/to/setup-sandcastle-queue/dist/cli.js configure-github \
  --config .sandcastle/config.json
```

输出会区分自动可管理 resources 与人工事项。确认创建或复用 labels、`sandcastle` Environment、provider variable 和 provider secret 后，显式列出全部四类：

```bash
GITHUB_TOKEN=... \
ANTHROPIC_BASE_URL=https://provider.example.com \
ANTHROPIC_AUTH_TOKEN=... \
node /path/to/setup-sandcastle-queue/dist/cli.js configure-github \
  --config .sandcastle/config.json \
  --confirm-resources labels,environment,provider-variable,provider-secret
```

工具不会创建 PAT、GitHub App、branch protection、ruleset、organization policy、Actions 高权限设置或 Environment required reviewers。维护者必须按 preview diagnostics 在 GitHub UI 中处理这些事项。

## Local doctor 与 remote doctor

安装后先运行不接触网络的检查：

```bash
node /path/to/setup-sandcastle-queue/dist/cli.js doctor --offline
```

offline mode 检查 config schema、managed hashes、runtime skills、runtime/command 一致性和 workflow security contract。完整 local doctor 还会读取 GitHub labels、Environment resources、repository settings 与 candidate-bound remote doctor artifact：

```bash
GITHUB_TOKEN=... \
ANTHROPIC_BASE_URL=https://provider.example.com \
ANTHROPIC_AUTH_TOKEN=... \
node /path/to/setup-sandcastle-queue/dist/cli.js doctor
```

remote-doctor operation 只允许 dedicated `workflow_dispatch` job，使用 `fast` model 验证 credential、broker、sandbox、network policy、job permissions 和 artifact upload。权限证据从当前 checkout 的受管 workflow 精确解析 `remote-doctor` job 声明，并由实际 checkout 与 artifact upload 验证获准能力；GitHub 不提供 job token 的 effective permission map，而 remote doctor 的零写入合同也禁止用 issue/PR mutation 探测拒绝能力。成功 artifact 绑定 installation version、configuration hash 与 workflow SHA。dispatcher 和 artifact 路径已有本地合同测试，但当前候选尚未取得远端成功 artifact；本地 doctor 会保留失败或缺失诊断，不会把它当作通过。

## Batch 与 Ticket 状态

| Term | 含义 |
| --- | --- |
| Batch | 一个父 PRD 下的一次受控交付，拥有稳定 ID、branch、draft PR 和 audit timeline |
| Ticket | 正文唯一 `## Parent` 指向该父 PRD 的子 issue |
| Frontier | 当前同时满足 open、ready label、ownership label、无 assignee、无 native blocker 的 Tickets |
| Continuation Run | 同一 Batch 达到三票或时间阈值后的后续 run，重新读取 GitHub state，并校验 expected HEAD |
| Published Commit | host 从单票 verified diff 创建并 atomic push 的唯一 commit，带 Batch、Ticket、Session trailers |
| Final Review | 对累计 diff 的 Standards 与 Spec 双轴检查，两轴都无 actionable finding 才通过 |

`status --parent <issue>` 是只读入口。`start --parent <issue>` 先列出只缺 ownership label 的 enrollment candidates；维护者用 `--enroll 2,3` 或 `--enroll none` 固定选择，再确认返回的 `confirmationHash`。runner 不会因为 issue 内容或 ready label 自动补 ownership label。

处理状态包括 `awaiting-enrollment`、`blocked`、`executable`、`published`、`waiting-no-change`、`checkpointed`、`failed` 与 `stale-continuation`。所有子票都关闭后才进入 Final Review。`start`、`continue` 和 `resume` 已接入 host dispatcher；在生产运行前，仍应先取得目标仓库的 remote doctor 与 candidate-bound gate 证据。

## no-change、abort 与 finalize

Agent 没有产生 diff 时不会创建 empty commit，也不会自动关闭 Ticket。host 先记录 `waiting-no-change` candidate，维护者再通过人工 `workflow_dispatch` 运行 `accept-no-change`，记录理由并关闭指定 Ticket。全部 Tickets 都是 no-change 时，Batch 进入 `completed-no-change`，不创建空 PR；父 PRD 只有在独立运行 `complete-no-change` 后才会关闭。完成记录与父 PRD 终态都可验证后，operation 才按 expected HEAD 删除 `sandcastle/active`；重试会验证同一 completion record 后幂等成功。

abort 要求没有 active processing run。它校验 Batch、HEAD 和 draft PR，保留 Batch branch，关闭 draft PR，并重新打开由该 Batch 关闭但尚未进入默认分支的 Tickets。abort audit 使用不可变 decision records，跨 API 中断后可以继续同一个决定，不会无界重试；completed audit 写入后按 expected HEAD 释放 `sandcastle/active`。

有代码变更的 Batch 在 Final Review 通过时只把 draft PR 标记 ready，仍属于非终态，不能释放 active ref。PR merge 后，维护者通过人工 `workflow_dispatch` 运行 `finalize-batch`，并提供精确 `batch_id`、`expected_head` 与 `pull_request`。host 只有在 PR 为 `closed`、`merged`，且其 head branch 与 HEAD 精确匹配该 Batch 时才删除 `sandcastle/active`；ref 已不存在时幂等成功，ref 已属于其他 HEAD 时 fail closed。

## 安全模型

### credential broker

真实 provider token 只进入 host 侧 credential broker。每个 Agent session 得到绑定 Batch、scope、model allowlist 和期限的一次性 token。broker audit 只记录 timestamp、model、status、latency 与 usage，不记录 request/response body。sandbox 不获得 GitHub token 或长期 provider token。

### sandbox network

bootstrap、Agent 与 verification 在 internal Docker network 中运行，经 `sandcastle-egress` proxy 访问 adapter registry allowlist 和明确配置的 hosts。容器使用 read-only filesystem、drop all capabilities、`no-new-privileges`、受限 PID、非 root user，并拒绝 caller 提供 `--network`、`--mount`、`--privileged` 或 Docker socket。

### protected paths

以下内容不能由 Ticket Agent 修改并发布：

- `.github/workflows/sandcastle.yml`
- `.github/actions/sandcastle/`
- `.sandcastle/`
- `skills-lock.json`
- `.agents/skills/code-review/`
- `.agents/skills/implement/`
- `.agents/skills/tdd/`
- `.agents/skills/sandcastle-runtime/`

host 在 commit/push 前同时检查 tracked 与 untracked changes。发现 protected paths 后返回 `PROTECTED_PATH_MODIFIED`，不会退回不受限模式。

### operation permissions

workflow 顶层不授予权限，job 按 operation 单独声明。`process` 与 `final-fix` 可以写 contents、issues、pull requests 和 Actions；`review-only` 可写 issues、pull requests 和 Actions，并仅为同步已验证的人工作业 HEAD 写 contents；`abort` 写 contents、issues 和 pull requests，并只读 Actions；`accept-no-change` 只读 contents 与 Actions，可写 issues；`complete-no-change` 写 contents 与 issues，并只读 Actions；`finalize-batch` 只写 contents、只读 pull requests，不授予 issues 或 Actions 权限；`remote-doctor` 只读 contents，只为 artifact upload 写 Actions，不授予 issue 或 pull request 权限。sandbox 发出的 capability request 一律拒绝。

### threat boundary

这些边界限制 prompt injection 或恶意 repository code 能拿到的凭据和 GitHub 副作用，但不能让已授权的 model call 变成零风险。host、GitHub Actions runner、provider、public registries、固定 control-plane image 和维护者确认仍属于 trusted computing base。私有 registries、submodules/LFS credentials、self-hosted runner、arbitrary internet、host network 与 Docker socket 不在支持范围内。

## Runtime adapter 指南

| Adapter | 必需输入 | Bootstrap 与环境身份 | 锁定规则 |
| --- | --- | --- | --- |
| `python-pip` | `.python-version`、`requirements.txt` | `python -m pip install ...`，随后 `pip freeze --all` | direct dependency 只能用 `name==version` |
| `python-uv` | `.python-version`、`pyproject.toml`、`uv.lock` | `uv sync --frozen`，所有命令带 `--frozen` | lock 必须包含 exact package versions |
| `node-npm` | `.nvmrc` 或 exact `engines.node`、`package-lock.json` | `npm ci` | 只接受 lockfile v2/v3，package identity 必须匹配 |
| `go-module` | `go.mod`，有 dependencies 时还需 `go.sum` | `go mod download`、`go mod verify` | `go` 与 `toolchain` 使用相同 exact patch，校验 sums |
| `java-maven` | `.java-version`、`pom.xml`、Maven Wrapper | strict-checksum `dependency:go-offline` | JDK 21 exact patch、首版 Maven 3.9.9 官方 URL/digest、checksum-enforcing wrapper，拒绝 SNAPSHOT/range |
| `composite` | 至少两个内置 adapters | 按人工确认顺序 bootstrap，再执行全部 tests/verification | schema v1，记录每个 component exact version |
| `custom` | project-owned config | 直接 `argv` bootstrap、tests、verification | schema v1、exact version、exact hosts，拒绝 shell 与 Docker escape |

每次 bootstrap 都会计算 resolved environment hash。Continuation Run 先重算该身份，不一致时进入 `environment-drift`，不会继续执行旧环境上的 Ticket。

## Audit 与 reconciliation

每个 run 产生一条长期 summary comment 和一个短期 sanitized JSON artifact。audit 关联 Batch、run/predecessor、start/end HEAD、Ticket、Session、Published Commit、skills receipts、runtime hashes、review heads、timing 与 outcome。它不保存 raw transcript、prompt/response、token、完整环境变量或完整命令输出。无 PR 的 no-change Batch 使用父 PRD comments。

push、issue closure 和 audit comment 无法跨 GitHub API 原子提交。恢复时以 remote reachable Published Commit 为权威：push 已完成而 issue 仍 open 时补 closure；closed issue 缺少合法 commit 或 completion record 时 fail closed；重复或冲突 commit、unexpected remote HEAD、Batch metadata mismatch 都进入 reconciliation failure，不会重新实现同一 Ticket。

## Upgrade、adopt、rollback 与 uninstall

这些命令都先返回 preview/plan，应用时必须保存 `.result.plan` 并确认其 `planHash`。

### upgrade

```bash
node /path/to/setup-sandcastle-queue/dist/cli.js upgrade --target 1.0.0
```

target 必须是当前精确 CLI package 可提供的 SemVer。未修改的 managed assets 可以更新；hash drift 进入 conflict，只输出 candidate diff，不自动 merge 或 force overwrite。项目配置的 schema migration 需要单独提供 config，并把变更纳入 preview。

### adopt

adopt 只接受 quiescent legacy repository：没有 queued/running legacy workflow，旧 integration PR 已完成，或维护者用 `--confirm-pr-opt-out <numbers>` 明确退出管理。它识别 Sandcastle-specific skill patches，把扩展迁到 wrapper，再恢复受控 upstream snapshot。失败不会留下 partial install。

```bash
GITHUB_TOKEN=... \
node /path/to/setup-sandcastle-queue/dist/cli.js adopt \
  --config /tmp/sandcastle-config.json
```

### rollback

```bash
node /path/to/setup-sandcastle-queue/dist/cli.js rollback --target 1.0.0
```

rollback 从目标 release 重新生成 candidate tree，并执行与 upgrade 相同的 hash、precondition 和 schema checks。当前 CLI 只能恢复它自身携带的精确 release，不会联网解析 floating tag。

从 `1.0.0` 恢复到 `0.1.x` 时，必须使用目标 `0.1.x` 的精确 CLI package 生成 plan；当前 `1.0.0` package 不携带历史 templates，也不会下载或猜测旧版本。

### legacy lifecycle dogfood gate

`.github/workflows/legacy-dogfood-release-gate.yml` 只接受 maintainer 手工触发。调用时必须重复确认 verifier candidate、quiescent legacy baseline 与已发布的精确 SemVer，并提供安装着旧 Sandcastle 的真实目标仓库。中央 workflow 只 dispatch 目标仓库的 `sandcastle-legacy-dogfood.yml`，不会替目标执行 `commit`、`push`、`stash` 或 `reset`。

目标 workflow 必须把 `legacy-dogfood.json` 放入名为 `sandcastle-legacy-dogfood-<gate-id>` 的 artifact。证据须绑定 candidate、baseline、release、repository 与 workflow run，并包含以下可复核结果：

- adopt 前没有 queued/running legacy workflow，旧 integration PR 已完成或明确退出管理；
- Sandcastle-specific `code-review` patch 已迁入 wrapper，受控 skill snapshots 已恢复；
- adopt 后 local doctor、remote doctor、upgrade、managed drift conflict 与精确 rollback 全部通过；
- failed apply 和 drift conflict 的前后 tree hashes 相同，rollback actual hash 与 expected hash 相同；
- adopt、managed drift conflict、rollback 与 upgrade 的计数都必须精确为一，自动 commit、push、stash 与 reset 的计数全部为零；
- 每个 dogfood finding 只记录受限 code、GitHub issue number、`fixedInRelease` 与 reverified 状态，且修复 release 不得晚于本次被测 release。

中央 `verify-legacy-dogfood` verifier 不保留不符合 schema 的目标 payload，只上传 candidate-bound 的成功报告或稳定的脱敏失败诊断。缺少发布物、目标 workflow、证据 artifact 或任一必需检查都会 fail closed。当前仓库没有真实成功 run 证据；不得把 workflow 合同测试记作 dogfood 完成。

### three-ticket Batch dogfood gate

`.github/workflows/batch-dogfood-release-gate.yml` 只允许 maintainer 手工触发，并把成功的 legacy lifecycle dogfood run ID 与报告 hash 作为硬前置条件。维护者还必须重复确认 verifier candidate、真实项目 base SHA 与精确 release，提供一个新父 PRD 和按依赖顺序排列的三张不同 Tickets。中央 workflow 只 dispatch 目标仓库的 `sandcastle-batch-dogfood.yml`。

目标 workflow 必须把 `batch-dogfood.json` 放入名为 `sandcastle-batch-dogfood-<gate-id>` 的 artifact。`verify-batch-dogfood` 要求证据同时满足：

- 三张 Tickets 通过人工 enrollment 加入新 Batch；第二、三票各引用已排在前面的 native dependency，总依赖边不少于两条；
- 每票恰好一次 implementation 和 publication，context、session、Published Commit 与 processing run 均唯一；
- checkpoint 在 `21600` 秒限制之前产生，predecessor/continuation run 与 state hash 可关联；
- 第一票失败后的 resume 或等价 recovery，以及 push 成功但 closure 未完成后的 recovery，都只产生一次实现、发布与关闭结果；
- cumulative Final Review 完成，随后至少走过一次 Final Fix 或 human review-only 路径，最终 findings 为零；
- audit timeline 能关联父 PRD、Tickets、sessions、skill receipts、commits、PR 与 runs，且明确不含 raw transcript 或 secrets。

验证成功后保存的报告只包含受限 IDs、hashes、计数、拓扑和状态；任何额外目标 payload、重复身份、超时 checkpoint、stale legacy prerequisite 或不安全 audit 都会被丢弃并 fail closed。当前没有真实三票成功证据，因此不得把 dispatcher 或 verifier 的合同测试记作 Batch dogfood 完成。

### stable `1.0.0` release gate

`.github/workflows/release.yml` 只接受 exact `1.0.0` tag，并要求重复确认 candidate SHA、tag 与同一个 exact `0.1.x` dogfood release。release-gate job 在任何 npm 或 GHCR 凭据进入 runner 前完成以下检查：

- candidate-bound credentialless fixture/contract CI 与 live E2E 报告成功，且两组 live fixtures 都包含 successful remote doctor；
- legacy lifecycle 与三票 Batch dogfood 报告都绑定同一 candidate 和 `0.1.x`，Batch 报告引用相同 legacy run，dogfood findings 已 reverify，Final Review findings 为零；
- npm tarball、skill snapshot、GitHub Release asset plan 与 `linux/amd64` control-plane image 共享 `1.0.0`、source manifest、dependency locks、checksums 和 immutable digest；
- `RELEASE_NOTES.md` 随 package 分发，并作为 GitHub Release notes，覆盖支持边界、已知限制、安全模型和 `0.1.x` upgrade；
- publish 后重新下载 npm package 与全部 GitHub Release assets 比较 SHA-256，并验证 GHCR pushed digest、tag target 与 release state。

缺少任一真实 gate artifact 时 publish job 不可达。当前候选尚未取得 remote doctor、live E2E、legacy dogfood 与 Batch dogfood 的远端成功证据，也没有创建 tag、push、npm publish、GitHub Release 或 GHCR publish；版本号与 release notes 只表示待验证候选，不表示已经发布。

### uninstall

```bash
node /path/to/setup-sandcastle-queue/dist/cli.js uninstall
```

uninstall preview 只删除 hash 仍匹配的 installer-managed assets。默认保留项目配置、project-owned Agent docs、audit history、GitHub labels、Environment、secrets、历史 PR/comments/artifacts 和修改过的 managed files。应用前检查 removal 与 preserved entries，不能用 uninstall 当作强制清理。

## Final Review、base drift 与 human fix

Final Review 固定 Batch HEAD 和当前 default-branch target base，在 temporary merge result 上运行完整 tests 与 verification。Standards 和 Spec 两个 axes 都要返回与 HEAD 匹配的有效 evidence，任何 actionable finding 都会阻止 PR ready。

自动状态固定为 `review-0`、`fix-1`、`review-1`、`fix-2`、`review-2`。两轮 fix 后仍有 finding 时进入 `needs-human-fix`。人工追加的 human fix 必须线性、可达且不触及 protected paths，之后只允许完整 `review-only`，自动 fix quota 不会重置。

target base 第一次变化可以进入一次 replacement review；再次变化进入 `base-moving`。merge conflict 进入 `needs-base-resolution`，唯一允许的人工 base merge 必须以审计记录中的 Batch HEAD 和 target base 为精确 parents。unknown commit、unexpected merge、non-linear history 或 force-push 进入 `needs-reconcile`。

## 故障排查

| 诊断或状态 | 检查与处理 |
| --- | --- |
| `AMBIGUOUS_RUNTIME` | 列出所有 runtime signals，使用 `composite` 或确认一个确实代表完整项目的 adapter |
| `PENDING_PLAN_STALE` | repository state 已变化，重新生成 plan 并再次审阅 patch |
| `MANAGED_FILE_DRIFT` | 不要覆盖，确认 drift 来源后走 upgrade conflict 或人工恢复 |
| `GITHUB_*_MISSING` | 补齐 token、Environment resource 或人工 repository settings，再运行 full doctor |
| `REMOTE_DOCTOR_MISSING` / `FAILED` / `STALE` | 检查 workflow run、candidate binding、job permissions 与 sanitized artifact，不要用本地合同测试替代远端 evidence |
| `ENVIRONMENT_DRIFT` / `environment-drift` | 恢复 lock/runtime identity，重新 bootstrap，不要继续旧 continuation |
| `PROTECTED_PATH_MODIFIED` | 从 Ticket diff 移除 control-plane 修改；需要升级时走 installer lifecycle |
| `waiting-no-change` | 人工核对 spec 和原始 HEAD，再决定 accept-no-change |
| `stale-continuation` | 以 GitHub remote HEAD 和 Batch state 为准，不要重复执行 Ticket |
| `needs-human-fix` | 在现有 Batch branch 追加受限 human fix，然后运行完整 review-only |
| `needs-base-resolution` | 只创建精确双 parent 的 audited base merge，再 review-only |
| `base-moving` / `needs-reconcile` | 停止自动处理，审计 branch、HEAD、PR 与 commit graph 后人工决定 |

所有错误都应保留 CLI JSON、exit status、GitHub run URL 和 sanitized artifact。不要把 provider response body、raw transcript、token、完整环境变量或不受控命令输出贴到 issue 或 PR。
