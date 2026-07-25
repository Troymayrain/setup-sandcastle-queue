# 旧实现的保留、重写与删除边界：事实盘点

> 对应 Wayfinder decision ticket：[盘点旧实现的保留、重写与删除边界](https://github.com/Troymayrain/setup-sandcastle-queue/issues/48)
>
> 盘点固定点：`setup-sandcastle-queue@4dc2e5a54ce54ab9dba2df9b49b4ebc66661eb1f`；课程项目 `course-manage-platform@b71d7f4fae6ae81591c825f4ff5339073d4fc211`。

## 结论摘要

当前实现不是“围绕上游 Sandcastle 的 Queue Setup”，而是一套独立 control plane：

- 根依赖中没有 `@ai-hero/sandcastle`，运行时直接固定 Claude Code CLI、容器、credential broker、egress proxy、Agent evidence protocol 和 Batch 状态机。[当前 `package.json`](https://github.com/Troymayrain/setup-sandcastle-queue/blob/4dc2e5a54ce54ab9dba2df9b49b4ebc66661eb1f/package.json#L1-L52)；[control-plane `package.json`](https://github.com/Troymayrain/setup-sandcastle-queue/blob/4dc2e5a54ce54ab9dba2df9b49b4ebc66661eb1f/control-plane/package.json)
- 当前共有 60 个 `src/**/*.ts` 文件、25,746 行源码；根级 42 个 `test/*.test.mjs` 文件、13,980 行测试。复杂度主要集中在 `workflow/`、`batch/`、`ticket/`、`installer/`、`release/` 与 `sandbox/`。
- 课程项目走的是相反路径：直接依赖 `@ai-hero/sandcastle@0.12.0`，由 `run()`、`claudeCode()` 和 `docker()` 拥有 Agent、worktree、branch strategy 与 sandbox 生命周期；项目代码只补 Queue、GitHub 发布、审计和 final review。[课程项目 `package.json`](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/package.json)；[`main.mts`](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/main.mts)；[`runtime.mts`](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/runtime.mts)。

因此，没有任何大型旧业务模块适合原样成为新核心。可原样保留的候选只是一小组无领域状态的基础函数；installer、Queue、GitHub 与 continuation 中有若干机制值得提炼，但应围绕新模板重新实现；Agent/sandbox/provider runtime 必须由上游 Sandcastle 取代；旧 lifecycle、Batch control plane 和多制品发布应直接删除。

本报告是事实盘点，不是最终分类决议。Ticket 仍被以下四个未决 decision tickets 阻塞：

- [确定 Queue Template 的文件与所有权边界](https://github.com/Troymayrain/setup-sandcastle-queue/issues/44)
- [确定最小配置模型与 CLI 契约](https://github.com/Troymayrain/setup-sandcastle-queue/issues/45)
- [确定自动 Continuation Run 的最小可靠协议](https://github.com/Troymayrain/setup-sandcastle-queue/issues/46)
- [确定 GitHub 远端配置与凭据契约](https://github.com/Troymayrain/setup-sandcastle-queue/issues/47)

凡依赖这四项的问题，以下均标为“暂定”，不能据此直接批量删除。

## 分类口径

| 分类 | 含义 |
|---|---|
| 新边界内可保留 | 领域无关、接口很小，代码本身有机会继续使用；仍需在新契约确定后跑现有测试验证 |
| 仅提炼机制后重写 | 用户可观察行为或防御性检查有价值，但现有数据模型、输入输出或依赖方向属于旧 control plane |
| 由上游 Sandcastle 取代 | 职责属于 `run()`、Agent provider、sandbox、worktree、branch strategy 或 Sandcastle session lifecycle |
| 直接删除 | 已明确排除的产品能力，或只服务于旧 runtime/lifecycle/release 模型 |

“保留测试”在本报告中指保留测试意图，不代表保留当前测试文件；当前测试大多直接导入旧 `dist` API，无法在大规模删除后继续原样运行。

## 一、新边界内可保留

### 小型基础函数

| 模块 | 盘点 | 保留条件与风险 |
|---|---|---|
| [`src/canonical-json.ts`](../../src/canonical-json.ts) | 稳定 JSON 排序/序列化，无 Queue、Batch 或 runtime 状态 | 可保留；若新配置不再以 hash 作为公开契约，使用面会明显缩小 |
| [`src/hash.ts`](../../src/hash.ts) | 单一 SHA-256 helper | 可保留 |
| [`src/json.ts`](../../src/json.ts) | bounded JSON 读取与 record guard | 可保留；上限和错误类别应改为新 CLI 的契约 |
| [`src/git/environment.ts`](../../src/git/environment.ts) | 构造禁用 hooks/filters 等 host Git 环境 | 可保留；只应服务 installer 与 host GitHub 发布，不再服务自研 sandbox |
| [`src/git/object-id.ts`](../../src/git/object-id.ts) | SHA-1/SHA-256 object id 形状校验 | 可保留 |
| [`src/git/repository.ts`](../../src/git/repository.ts) | 解析 repository root 与 git-path | 可保留；错误类型目前依赖旧 `config.ts` |
| [`src/installer/safe-path.ts`](../../src/installer/safe-path.ts) | 防止模板写出 repository 或穿越 symlink parent | 可保留其实现与测试意图；“managed installation path”术语要改成“generated target path” |
| [`src/github/response.ts`](../../src/github/response.ts) | bounded response 与 pagination header 解析 | 可保留；建议成为新的小型 GitHub client 内部 helper |
| [`src/version.ts`](../../src/version.ts) | 从 package metadata 读 CLI version | 可保留 |

### 可保留的测试意图

- [`test/bounded-json-inputs.test.mjs`](../../test/bounded-json-inputs.test.mjs)：恶意或超大输入 fail closed。
- [`test/installer-apply.test.mjs`](../../test/installer-apply.test.mjs) 中的 symlink、path traversal、写前 repository precondition 与失败不留半套文件。
- [`test/github-config.test.mjs`](../../test/github-config.test.mjs) 中的分页、GitHub response shape 和 secret redaction。

这些是唯一接近“源码可直接继承”的部分。即使如此，它们通过 `ConfigurationError` / `InfrastructureError`、旧 plan envelope 与旧 CLI JSON envelope 相连，所以应先解耦错误类型再复用。

## 二、仅提炼机制后重写

### 1. Installer、模板、配置与 CLI

| 现有模块 | 值得提炼的机制 | 必须重写的原因 | 状态 |
|---|---|---|---|
| [`src/installer/plan.ts`](../../src/installer/plan.ts) | 在临时候选树生成完整 diff；记录写前 HEAD/index/file preconditions；区分 fresh/unmanaged collision | Plan 同时携带 adoption/upgrade/rollback、managed hashes、runtime wrapper 与旧 config；新首版只有 `init`、幂等重跑和冲突停止 | 暂定，等待“确定 Queue Template 的文件与所有权边界”和“确定最小配置模型与 CLI 契约” |
| [`src/installer/apply.ts`](../../src/installer/apply.ts) | 确认 `planHash`；写前复核；临时文件/backup/rename 的失败恢复 | 约一半逻辑验证 adoption/upgrade/rollback envelope 和 installer-owned manifest；新资产生成后归项目所有，不应重建 managed-file 状态机 | 暂定 |
| [`src/installer/templates.ts`](../../src/installer/templates.ts) | 以纯 render function 生成排序后的候选资产 | 当前模板嵌入 10 种 workflow operation、固定 control-plane image、vendored skills、provenance 和 installation manifest。[模板现状](https://github.com/Troymayrain/setup-sandcastle-queue/blob/4dc2e5a54ce54ab9dba2df9b49b4ebc66661eb1f/src/installer/templates.ts#L56-L124)；[资产现状](https://github.com/Troymayrain/setup-sandcastle-queue/blob/4dc2e5a54ce54ab9dba2df9b49b4ebc66661eb1f/src/installer/templates.ts#L443-L542) | 暂定，文件清单尚未决 |
| [`src/config.ts`](../../src/config.ts)、[`schema/config.schema.json`](../../schema/config.schema.json) | 严格 schema、拒绝未知字段、argv 数组避免 shell interpolation | 现有 schema 的主体是语言 adapter、network hosts、model roles、固定 Batch limits 与 audit retention。[现有类型](https://github.com/Troymayrain/setup-sandcastle-queue/blob/4dc2e5a54ce54ab9dba2df9b49b4ebc66661eb1f/src/config.ts#L39-L104)；新配置已锁定为通用 bootstrap/test/verification commands 和独立 `.sandcastle` 工具子项目 | 暂定，等待最小配置契约 |
| [`src/cli.ts`](../../src/cli.ts)、[`src/index.ts`](../../src/index.ts) | 机器可读错误类别、预览后确认、CLI/库共用 core 的思路 | 当前 CLI 是旧系统全部能力的聚合根，直接 import runtime、broker、sandbox、Batch、review、release gate 等近全部模块。[CLI imports](https://github.com/Troymayrain/setup-sandcastle-queue/blob/4dc2e5a54ce54ab9dba2df9b49b4ebc66661eb1f/src/cli.ts#L1-L100)；新公开面只有精确版本 `npx ... init` 与只读 `doctor` | 必须重写入口，不应边删边修当前 switch |
| [`src/doctor.ts`](../../src/doctor.ts) | 一次输出本地配置、文件、workflow、GitHub 状态的诊断清单 | 当前 doctor 依赖 installation manifest、managed hashes、vendored skills、runtime detection、remote-doctor binding 与旧 workflow security。[doctor checks](https://github.com/Troymayrain/setup-sandcastle-queue/blob/4dc2e5a54ce54ab9dba2df9b49b4ebc66661eb1f/src/doctor.ts#L1-L49) | 暂定，保留“只读诊断”产品能力但重写检查项 |

关键事实：现有 installer 的原子 patch 机制和安全路径检查有价值，但不能把 `InstallPlan`、`.sandcastle/installation.json` 或 ownership enum 当作新模型。已锁定的生命周期明确排除了 managed upgrade/rollback/uninstall；继续携带这些 schema 会把旧状态机偷偷带回新产品。

### 2. GitHub 远端配置与 Queue

| 现有模块 | 值得提炼的机制 | 必须重写的原因 | 状态 |
|---|---|---|---|
| [`src/github/configure.ts`](../../src/github/configure.ts) | 从 origin 解析 repository；先 preview 后按 category 明确确认；secret 永不回显；幂等 label upsert | 当前资源固定为 Environment、provider variable/secret，且用 `libsodium` 直接写 Actions secret；新模型还有 host write token、Agent read-only token、上游 provider env 与 permission contract | 暂定，等待“确定 GitHub 远端配置与凭据契约” |
| [`src/github/frontier.ts`](../../src/github/frontier.ts) | 分页；逐票 fresh read 避免 stale list；label 大小写归一；native `blocked_by`；按 issue number 排序 | 当前模型要求父 PRD、`## Parent`、双 label、trusted comments snapshot/spec hash 与 Batch membership；已确认的新 Ticket Contract 是课程项目的固定正文 sections、ready label、activation ownership label、无 assignee 与 blocker gate | 应围绕课程项目 [`activate-tickets.mts`](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/activate-tickets.mts) 和 [`frontier.mts`](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/frontier.mts) 重写 |
| [`src/batch/start.ts`](../../src/batch/start.ts) | repository concurrency 的远端检查；create-only integration branch；确认后才 mutation | 现有 start 以父 PRD、Batch ID、active ref、enrollment preview 为核心；新基线由首次 workflow 自动从 base HEAD 创建 integration branch，不存在父 Batch 实体 | 只提炼 race/branch safety，删除 Batch identity |
| [`src/ticket/publish.ts`](../../src/ticket/publish.ts) | push 后再 close；remote HEAD 验证；crash-after-push reconciliation；draft PR create-or-reuse | 现有文件 1,235 行，耦合 Batch marker、one-ticket-one-commit squash、protected paths、publication comments 与 Batch trailers；课程基线只要求稳定 branch、成功 push、close 和 PR | 重写成小型 host publisher；是否保留 expected HEAD 取决于 continuation 决议 |
| [`src/workflow/github.ts`](../../src/workflow/github.ts) | 小型 GitHub API client 和统一错误处理 | User-Agent、operation permissions 和 request shape 均绑定旧 workflow host | 可作为新 helper 的参考，不保留 public API |
| [`src/workflow/security.ts`](../../src/workflow/security.ts) | 对 generated workflow 做离线 permissions contract test | 现有矩阵对应 8 类旧 operations；新模板 operation 数和 permissions 尚未决 | 暂定，测试方法保留、矩阵重写 |

### 3. 自动 Continuation Run

| 现有模块 | 值得提炼的机制 | 必须重写的原因 | 状态 |
|---|---|---|---|
| [`src/batch/run.ts`](../../src/batch/run.ts) | 每 run 的 ticket/time budget；单票 hard timeout；失败立即停止；checkpoint 后 dispatch；continuation 用 expected HEAD/predecessor；重复或 stale run 安全退出 | 数据模型仍要求 `BatchRunState`、父 PRD、固定 Batch ID、published/no-change/conflict 状态全集，并把 350/300/140/120/3 写成唯一合法常量。[现有 contract](https://github.com/Troymayrain/setup-sandcastle-queue/blob/4dc2e5a54ce54ab9dba2df9b49b4ebc66661eb1f/src/batch/run.ts#L1-L130) | 暂定，等待“确定自动 Continuation Run 的最小可靠协议” |
| [`src/batch/github-run.ts`](../../src/batch/github-run.ts) | 从 GitHub Issues、branch HEAD 与 workflow dispatch 重新建立远端事实；不依赖 runner disk/artifact | 读取逻辑以 Batch metadata、publication/no-change comments 和 commit trailers 为权威；新系统明确不建设完整 Batch 状态机 | 仅提炼 fresh-read、dedupe 和 dispatch 机制 |
| [`src/batch/host-runtime.ts`](../../src/batch/host-runtime.ts) | 将纯调度 loop 与 GitHub/Agent side effects 分离，便于 contract test | runtime adapter 指向自研 ticket driver 与 audit；新 runtime 是 `.sandcastle` 内调用上游 `run()` 的模板代码 | 保留依赖反转测试思路，源码重写 |

这里最容易误删过度：`batch/` 整体属于旧 Batch 产品，但 `run.ts` 已经包含用户后来明确要求的“有界 run、自动接力、异常才人工介入”的先验。应删除 Batch 类型和状态，不应丢掉 expected HEAD、concurrency、dispatch dedupe、run/ticket time budget 与远端重读的测试场景。

### 4. 轻量审计、final review 与 base 漂移

| 现有模块 | 值得提炼的机制 | 必须重写的原因 |
|---|---|---|
| [`src/audit/run.ts`](../../src/audit/run.ts) | bounded/redacted JSON；记录 session/base/head/outcome；上传 artifact；不保存 raw prompt/response | 当前实现向长期 PR comment 追加事件，验证 Batch、image digest、dependency hashes 和自定义 evidence receipts；已确认首版只保留课程项目轻量 JSON/Markdown summary |
| [`src/final-review/base.ts`](../../src/final-review/base.ts) | 在临时 worktree 做最新 base 的试合并并运行完整验证，不 rebase/force-push integration branch | 当前状态机支持 authorized human base merge、replacement review 与 base-moving；新决议仅需要一次试合并失败即等待人工 |
| [`src/final-review/run.ts`](../../src/final-review/run.ts)、[`fix.ts`](../../src/final-review/fix.ts) | 固定 reviewed HEAD、structured findings、review/fix 有界终止 | 当前是双轴 review、最多两轮 fix、自定义 evidence protocol；新决议是一次 review、最多一次 fix、再复审一次，并由上游 `run()` 执行 |
| [`src/workflow/artifact.ts`](../../src/workflow/artifact.ts) | `if: always()` 路径下上传脱敏 summary/artifact | 依赖当前 control-plane package 与 `@actions/artifact`；新模板可直接使用 `actions/upload-artifact`，未必需要源码依赖 |

课程项目的 [`audit-log.mts`](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/audit-log.mts) 已经展示更小的行为基线：从临时 verbose JSONL 只提取 `tdd` / `code-review` 调用状态，随后删除 raw log，再写 session/base/head 的脱敏 JSON。课程项目的 [`review.mts`](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/review.mts) 直接用上游 `run()` 实现 review/fix。因此旧审计与 final-review 源码不应迁移，只保留这些可观察行为的测试。

## 三、由上游 Sandcastle 取代

| 模块 | 当前职责 | 取代理由 |
|---|---|---|
| [`src/agent/driver.ts`](../../src/agent/driver.ts) | 直接 spawn `claude`，固定 prompt、output/evidence 文件和 permission mode | provider/Agent lifecycle 属于 `claudeCode()`；课程项目已直接使用上游 Agent provider |
| [`src/control-plane.ts`](../../src/control-plane.ts) | 自有 runtime binary 的 command router | 新产品不是常驻/容器化 control plane；运行期入口应是目标项目 `.sandcastle` 模板 |
| [`src/ticket/process.ts`](../../src/ticket/process.ts) | 创建 session contract、启动自研 sandbox、校验自定义 tool-call evidence、host verification | 上游 `run()` 已拥有 fresh worktree、session、Agent、branch strategy 和 hooks；课程项目 `main.mts` 已验证该组合 |
| [`src/sandbox/policy.ts`](../../src/sandbox/policy.ts) | 组装 Docker CLI、mount、network、protected paths、观察 Agent 结果 | sandbox 生命周期与 Docker provider 由 `@ai-hero/sandcastle/sandboxes/docker` 提供 |
| [`src/sandbox/egress-proxy.ts`](../../src/sandbox/egress-proxy.ts) | 自建 allowlist 出站代理 | 已明确排除自建 egress proxy |
| [`src/broker/server.ts`](../../src/broker/server.ts) | host-side provider credential broker、session token、usage audit | 已明确采用上游标准 provider env，不建设 broker |
| [`src/runtime/execute.ts`](../../src/runtime/execute.ts)、[`composite.ts`](../../src/runtime/composite.ts)、[`custom.ts`](../../src/runtime/custom.ts) | 自研应用 bootstrap adapter 执行与环境 hash | 新项目适配接口是通用 commands，不再存在 runtime adapter |
| [`src/workflow/remote-doctor-runtime.ts`](../../src/workflow/remote-doctor-runtime.ts) | 以 broker + sandbox + provider probe 做 Actions smoke test | 三个依赖均已退出首版；只读 `doctor` 的远端资源检查另行重写 |
| [`src/workflow/final-review-runtime.ts`](../../src/workflow/final-review-runtime.ts) 中的 Agent/sandbox 执行部分 | 自研 review/fix driver、evidence、protected path 与 phase machine | review/fix session 应由上游 `run()` 创建；最多一次 fix 的薄编排留在模板 |

这组代码不是“质量较差所以删除”，而是职责所有权错误。保留它们会形成第二套 Sandcastle，即使把类型名改成 Queue 也不会改变边界。

## 四、直接删除

### 已明确退出首版的 lifecycle

- [`src/installer/adopt.ts`](../../src/installer/adopt.ts)
- [`src/installer/upgrade.ts`](../../src/installer/upgrade.ts)
- [`src/installer/uninstall.ts`](../../src/installer/uninstall.ts)
- `src/installer/apply.ts` / `plan.ts` 中所有 adoption、upgrade、rollback、uninstall envelope 与 pending managed lifecycle 分支
- 对应 [`test/adopt.test.mjs`](../../test/adopt.test.mjs)、[`test/upgrade.test.mjs`](../../test/upgrade.test.mjs)、[`test/uninstall.test.mjs`](../../test/uninstall.test.mjs) 与 legacy lifecycle fixture

原因不是暂时没时间，而是 Wayfinder map 已锁定：首版只有 fresh `init`、幂等重跑、冲突停止和只读 `doctor`，生成资产归目标项目所有。

### 旧 Batch/control-plane 专属状态

- [`src/batch/abort.ts`](../../src/batch/abort.ts)、[`finalize.ts`](../../src/batch/finalize.ts)
- [`src/batch/no-change.ts`](../../src/batch/no-change.ts)、[`no-change-records.ts`](../../src/batch/no-change-records.ts)
- [`src/workflow/abort-runtime.ts`](../../src/workflow/abort-runtime.ts)、[`finalize-runtime.ts`](../../src/workflow/finalize-runtime.ts)
- `workflow/host.ts` 中 `abort`、`accept-no-change`、`complete-no-change`、`finalize-batch` 分支
- PR body 中旧 Batch marker、父 PRD close policy、active ref、accepted-no-change record 和 correction event

新基线没有父 PRD Batch、人工 no-change acceptance、abort/reopen 状态机或 finalize operation。若将来真实 dogfood 暴露需要，应作为新需求重新设计，而不是保留休眠代码。

### 多制品 release 与 control-plane image

- 根 [`Dockerfile`](../../Dockerfile)
- `control-plane/`
- [`src/release/bundle.ts`](../../src/release/bundle.ts)、[`legacy-dogfood.ts`](../../src/release/legacy-dogfood.ts)、当前 [`batch-dogfood.ts`](../../src/release/batch-dogfood.ts) 与 current-image-bound [`live-e2e.ts`](../../src/release/live-e2e.ts)
- `.github/workflows/legacy-dogfood-release-gate.yml`
- 当前 `.github/workflows/batch-dogfood-release-gate.yml`、`live-e2e-release-gate.yml`、`release.yml` 的多制品/image gate 结构
- `release-manifest.json`、当前 `RELEASE_NOTES.md` 中对 npm/GitHub Release/skill/GHCR 同版本制品的承诺

唯一规范分发物已锁定为精确版本 npm CLI。新的 release workflow 与三次 continuation dogfood 仍需新增，但不应继承旧 image、skill snapshot 和 four-artifact parity 模型。

### Vendored runtime skills 与 setup skill 双入口

- `vendor/runtime-skills/`
- `vendor/sandcastle-runtime/`
- `.agents/skills/*` snapshot、`skills-lock.json`、skill provenance/third-party notice 生成逻辑
- 根 `SKILL.md` 和 `scripts/setup.mjs` 作为独立发布入口的实现
- [`src/installer/templates.ts`](../../src/installer/templates.ts) 中 `renderRuntimeSkillAssets()` 与 runtime wrapper

首版只有 npm CLI 规范入口，且上游 Sandcastle 是 runtime；继续 vendor `implement`/`tdd`/`code-review` 会延续旧 runtime ownership。若目标项目仍需要 Agent skills，应由项目/上游自身声明，不属于 Queue Setup 的受管 release 资产。

### 语言 runtime adapters

- [`src/runtime/detect.ts`](../../src/runtime/detect.ts) 全部 Python/pip、Python/uv、Node/npm、Go、Java/Maven 检测和精确版本策略
- `runtime/execute.ts`、`runtime/composite.ts`、`runtime/custom.ts`
- `test/python-adapters.test.mjs`、`node-adapter.test.mjs`、`go-adapter.test.mjs`、`java-adapter.test.mjs`、`composite-custom-adapter.test.mjs`、`runtime-detection.test.mjs`
- 现有 `test/fixtures/matrix.json` 的 adapter matrix

可以保留 Python、Node 和混合 fixture 作为新 `bootstrapCommands` / `testCommands` / `verificationCommands` 的跨语言证据，但不要保留 adapter API、锁文件解析器或 dependency registry allowlist。

### 旧持久审计协议

- [`src/audit/run.ts`](../../src/audit/run.ts) 的 PR 长期事件账本、image/dependency hash 证明与 correction event
- [`src/workflow/audit-runtime.ts`](../../src/workflow/audit-runtime.ts)
- 自定义 Agent evidence receipt、双轴 review evidence、Batch audit marker

保留的是“轻量脱敏 artifact + Markdown summary”的行为，不是当前 audit schema。

## 测试资产如何处置

### 可改造成新合同测试

| 旧测试 | 新测试意图 |
|---|---|
| [`test/installer-plan.test.mjs`](../../test/installer-plan.test.mjs)、[`installer-apply.test.mjs`](../../test/installer-apply.test.mjs) | `init` 完整 diff、显式确认、collision fail closed、失败不留半套文件、幂等重跑零差异 |
| [`test/config-cli.test.mjs`](../../test/config-cli.test.mjs) | 最小 `queue.config.json` 严格 schema、通用 argv commands、unknown field 拒绝、CLI exit/JSON |
| [`test/doctor.test.mjs`](../../test/doctor.test.mjs) | 新资产存在、上游 Sandcastle 精确版本、workflow、commands、GitHub labels/secrets/variables 的只读检查 |
| [`test/frontier.test.mjs`](../../test/frontier.test.mjs) | 固定正文 sections、未完成验收项、ready/ownership label、无 assignee、native blockers、pagination、stale list fresh read、ordering |
| [`test/batch-run.test.mjs`](../../test/batch-run.test.mjs) | 30 张 tickets、每 run ticket/time budget、expected HEAD、重复 continuation、防并发、队列清空后停止 |
| [`test/ticket-publish.test.mjs`](../../test/ticket-publish.test.mjs) | push/remote HEAD/close 顺序、push 后 crash 的幂等恢复、draft PR reuse |
| [`test/final-review.test.mjs`](../../test/final-review.test.mjs)、[`final-fix.test.mjs`](../../test/final-fix.test.mjs)、[`base-drift.test.mjs`](../../test/base-drift.test.mjs) | 一次 review、最多一次 fix、复审一次；最新 base 临时试合并、测试、冲突时停下 |
| [`test/audit.test.mjs`](../../test/audit.test.mjs) | session/base/head/result、skill 调用状态、raw verbose log 被删除、artifact/summary 无 secrets |
| [`test/workflow-permissions.test.mjs`](../../test/workflow-permissions.test.mjs) | 新 workflow 的最小权限、人工首次 dispatch、repository concurrency、自动 continuation |

### 应删除而不是改名的测试

- adopt/upgrade/rollback/uninstall 与 managed hash drift 测试。
- broker、egress/network allowlist、custom sandbox evidence 和 protected control-plane path 测试。
- runtime adapter exact dependency/version/hash 测试。
- Batch abort/finalize/no-change、双轴 review、两轮 fix、base-moving/replacement-review 状态机测试。
- npm/GitHub Release/skill/GHCR image parity 与旧 dogfood gate schema 测试。

### 测试基础设施风险

现有测试普遍执行构建后的 `dist` 并断言旧公共 JSON schema；[`src/index.ts`](../../src/index.ts) 还 re-export 近全部旧 API。不能先逐文件删除实现再期待旧测试指导迁移。安全做法是先建立新的 `init`/`doctor` 与 Queue Template 黑盒合同测试，再删除旧 exports 和对应测试；否则“保持测试为绿”会迫使新实现兼容已明确放弃的旧产品。

## 隐含依赖与删除风险

### 1. `config.ts` 是横跨所有旧子系统的隐形总线

`ProjectConfig` 同时承载 queue、runtime adapter、provider model roles、Batch limits 和 audit retention；`ConfigurationError` / `InfrastructureError` 又被几乎每个模块复用。直接删除 runtime 字段会让 installer、doctor、sandbox、batch、review、release gate 同时失去类型。应先建立新的小配置与独立通用 error module，再迁移可保留 helpers。

### 2. `templates.ts` 不是普通模板文件，而是旧产品装配根

它同时生成 workflow、config、skills snapshots、runtime wrapper、project docs、lock/provenance、installation manifest，并引用 workflow permission matrix 和 release image digest。若只“把 workflow 字符串换掉”，旧 ownership、skills 和 image release 仍会被 installer/doctor/release 引回。

### 3. `cli.ts` 与 `index.ts` 让所有旧能力成为编译/发布表面

CLI 顶层静态 import 几乎所有模块；`index.ts` 又将它们作为 package API 导出。大幅删除应先建立新的极小入口，再缩 package `files` 与 exports；不承诺旧 API 兼容已经被 Wayfinder map 明确锁定。

### 4. `doctor` 不能从旧版本做减法得到

当前 doctor 把 installation manifest、managed hashes、vendored skills、runtime detection、remote doctor artifact 和旧 workflow security 当成一组一致性证明。逐项关掉会留下语义不明的“pass”。新 doctor 应从新安装后应存在的事实重新列检查项。

### 5. 课程行为基线本身也不能逐文件复制

课程项目把 `@ai-hero/sandcastle` 和 `tsx` 放在根 `package.json`，并在 sandbox hooks 固定 `npm install`、`pip install -r requirements.txt`，workflow 还接受人工提供 integration branch；这些都与已锁定的新决议（独立 `.sandcastle/package.json`、通用 commands、首次 workflow 自动建 branch）不同。[课程 `runtime.mts`](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.sandcastle/runtime.mts)；[课程 workflow](https://github.com/Troymayrain/course-manage-platform/blob/b71d7f4fae6ae81591c825f4ff5339073d4fc211/.github/workflows/sandcastle.yml)。

此外，课程 workflow 当前写了 `timeout-minutes: 4320`，这不能绕过 GitHub-hosted runner 的单 job 上限；新实现必须使用自动 continuation，而不能复制该值。

### 6. 上游 Sandcastle 的工作目录与依赖安装方式需要专门验证

新决议把工具依赖放进 `.sandcastle/package.json`，但课程项目通过根 `node_modules` 与 `copyToWorktree: ["node_modules"]` 工作。需要在 Queue Template 设计中验证：

- `.sandcastle` 子项目如何执行 `tsx`/导入 `@ai-hero/sandcastle`；
- Sandcastle worktree 中需要复制哪些子项目依赖；
- 应用 bootstrap commands 在 sandbox/worktree 的 repository root 还是 `.sandcastle` cwd 执行；
- lockfile 与上游精确版本如何被 `doctor` 校验。

这是迁移风险，不是保留旧 runtime adapter 的理由。

### 7. GitHub Actions 自动接力权限与递归触发尚未定案

旧代码的 `dispatchBatchContinuation()`、expected HEAD 和 predecessor run ID 提供了先验，但它与旧 Batch ID/branch metadata 绑定。“确定自动 Continuation Run 的最小可靠协议”未关闭前，不能决定 `batch/run.ts` 中哪些字段/分支最终保留，也不能决定 generated workflow 是否需要 `actions: write` 或使用何种 dispatch endpoint。

### 8. GitHub secrets 写入方式影响依赖删除

当前 `github/configure.ts` 使用 `libsodium-wrappers` 加密 repository/environment secret；若新 `init` 改为委托 `gh secret set`，可以删除 `libsodium-wrappers` 和一批 key-fetch/encryption 代码；若仍直接调 API，则该机制可能保留。该选择属于“确定 GitHub 远端配置与凭据契约”，本报告不代替决策。

### 9. `@actions/artifact` 很可能可以删除，但尚非最终结论

当前依赖是为 control-plane runtime 内上传 artifact。新 Queue Template 可以直接生成 `actions/upload-artifact` step，CLI 本身无需依赖 `@actions/artifact`。若最终仍要求 Node runtime 在 `if: always()` 中动态产出并上传 artifact，才需重新评估。

### 10. Git 历史按旧 PRD 的竖切票构建，不能把 commit 当成新迁移单位

历史从 installer（`#2`–`#12`）扩张到 frontier/Batch（`#13`–`#21`）、audit/review（`#22`–`#28`）、runtime adapters（`#29`–`#33`）和多制品 release gates（`#34`–`#40`）。每个后期 commit 都建立在早期 config/template/control-plane contract 上。按 commit cherry-pick 会连带带回旧边界；只能按新的行为合同重建。

## 建议的删除/重建顺序（非实施计划）

这不是实施 ticket 拆分，只说明依赖安全边界：

1. 先冻结旧实现，只读保留为行为参考；不要在现有 `cli.ts`/`config.ts` 上继续加新分支。
2. 在新的小目录/入口建立 `init`、新 config、candidate renderer 与 `doctor` 黑盒合同。
3. 生成独立 `.sandcastle` 工具子项目，并用上游 `run()` 跑通单票。
4. 重建 Ticket activation/frontier、host publish、自动 continuation、final review/fix 与轻量审计。
5. 通过新 fixture、30 票合同和三次 continuation dogfood 后，再一次性移除旧 exports、control-plane、runtime、Batch lifecycle、release gates 与测试。
6. 最后缩减 dependencies、package `files`、README/OPERATIONS/RELEASE_NOTES，并以 `npm pack --dry-run` 验证发布面。

这一路径避免两种风险：过早删除旧代码导致行为先验丢失，以及为了让旧测试继续通过而把旧 API/schema 重新带进新产品。

## 待决分类清单

以下项目必须等待 blockers 关闭后才能从“暂定”升级为最终边界：

1. `renderCandidateAssets()` 最终生成哪些文件、是否还需要任何 manifest、哪些文件重跑时可覆盖。
2. `ProjectConfig` 最小字段、command cwd/env 表达、labels/model/runs-on 是否可配置。
3. `init` 的 preview/confirm JSON contract、幂等语义与 conflict exit code。
4. `doctor` 的本地/远端检查边界。
5. continuation 的 workflow inputs、expected HEAD、dispatch dedupe、最大接力次数、异常恢复与终止 marker。
6. GitHub resource 配置究竟通过 REST + libsodium 还是 `gh`，host/Agent/provider 三类凭据存放在 repository 还是 environment secrets/variables。
7. 新 workflow 是否仍需要源码级 permissions validator、artifact uploader 和 GitHub client。

在这些问题解决前，可以确定删除的是旧职责，不能确定的是最终替代文件名和接口形状。

## 一行判断

旧实现应当被当作“高覆盖率的需求与失败模式样本”，而不是新架构的代码底座：保留少量无状态 helpers，提炼 installer/Queue/continuation/publish 的防御机制，用上游 Sandcastle 替代执行内核，并删除旧 lifecycle、Batch control plane、runtime adapters、broker/proxy 与多制品 release。
