# 重构验证矩阵与发布门槛

## 决策

MVP 采用三层门槛，不沿用当前实现的 remote doctor、legacy lifecycle dogfood、语言 runtime adapter matrix、credential broker、GHCR image、skill snapshot或多分发物一致性 gate：

1. **本地合同通过**：本地 fixtures 与 30 票合同测试通过，证明新 Queue Setup 与 Queue Template 的静态合同成立；
2. **允许替代当前实现**：本地合同通过，并在课程项目完成一次 fresh 安装迁移和至少三次真实自动 Continuation Runs；
3. **允许 npm 发布**：允许替代当前实现，且同一候选的唯一 npm CLI tarball 通过打包、安装和发布前后冒烟验证。

五类证据必须绑定同一个候选 commit。任一必需证据缺失或失败即停止；MVP 不设置人工豁免、评分制、flaky 重跑配额或额外证明协议。

## 验证矩阵

| 验证面 | 最小可观察证据 | 通过条件 | 失败时的边界 |
| --- | --- | --- | --- |
| 本地 fixtures | 普通 CI 中可查看的测试结果，覆盖 Node、Python 与 Node/Python mixed 三种项目形状，以及 fresh、idempotent、partial/conflict 安装状态 | `init` 只产生既定 `.sandcastle/**` 与 `.github/workflows/sandcastle-queue.yml`；完整 diff、stale/collision/symlink/path traversal 与原子写入合同通过；幂等重跑零写入；生成的 `.sandcastle` 子项目可执行 lockfile install、typecheck 和模板测试；项目 `bootstrap`、`test`、`verification` argv 按声明顺序执行；workflow 静态权限与 Host/Agent 凭据隔离测试通过 | 不得用旧 runtime adapter fixture 补足失败项，也不得因某种语言 fixture 通过而忽略另一种项目形状 |
| 30 票合同测试 | 普通 CI 中一条确定性、无真实 Provider 凭据的黑盒测试记录 | 模拟 GitHub 远端中放入 30 张符合 Ticket Contract 的 Tickets，包含 native dependency 与同时可执行项；测试从首次启动一直运行到 Queue 清空，观察到每个 processing work unit 只选一票、共 30 次唯一 publication、按 issue number 确定性选择 frontier、每次使用前一 HEAD 作为下一次 `expected_head`、没有重复 Agent 调用/commit/closure，并只在有进展时产生下一次 dispatch；随后只产生一次 final review 路径并到达完成态 | 任何少票、重复票、乱序、stale HEAD 写入、零进展接力或未完成即 final 都失败。该测试验证协议规模，不调用 30 次真实模型，也不要求单个 Actions run 容纳 30 票 |
| 课程项目迁移 | 针对 `course-manage-platform` 固定 base commit 的可审阅安装 PR、CI run URL 与 `doctor` 输出 | 必须走新实现的 fresh `init`，不能走未提供的 adopt；变更只进入两个安装命名空间和经维护者明确选择的项目脚本/配置修改；不把 Sandcastle 依赖写入应用根 package；课程项目原有 test/verification 在安装前后均通过；`doctor --offline` 与完整只读 `doctor` 通过；维护者能从生成文件直接说明项目命令、模型、labels、分支和 prompts 的定制位置 | 需要手改 Setup 生成器、引入语言 adapter、修改应用业务代码才能安装，或只靠原型/本地临时目录跑通，均不算迁移完成 |
| 真实自动接力 dogfood | 同一课程项目、同一 Integration Branch 上的首次人工 run 和至少三个由前序 run 自动 dispatch 的后继 run URL，以及对应 Issues、completion commits、draft PR 和脱敏 summaries | 首次 run 之后至少连续三次 Continuation Runs 无人工 dispatch/resume；至少四个不同工作单元绑定严格递进的 `expected_head`；每张 Ticket 使用新的上游 Sandcastle session，均先 push 唯一 completion commit 再关闭 Issue；所有后继 run 复用同一 Integration Branch 与 draft PR；Host `GITHUB_TOKEN` 未进入 Agent，Agent 无 GitHub token；原始 Agent stream 未保留；Queue 清空后完成一次 final review，若有 fix 则最多一次且随后独立复审；最终 PR 可进入人工评审 | 人工点击后三次、一个 run 内循环处理多票、复用 session、依赖 runner/cache 私有状态、仅有 workflow mock、或以失败后人工恢复凑足 run 数均不算自动接力证据 |
| npm 发布 | 同一候选 commit 的 CI run、`npm pack --dry-run --json`/`npm pack` 输出、临时仓库安装冒烟结果，以及发布后的 registry 查询与重新安装结果 | package 只发布一个 npm CLI 分发物；tarball 只包含 CLI、生成模板、许可证和运行所需文件，不包含旧 control plane、runtime adapters、broker/proxy、旧 release assets 或原型；在干净 Node.js 22 环境安装 tarball 后，`--version`、`--help`、fresh `init` 的生成结果和 `doctor --offline` 均通过；package version、Git tag 与候选 commit 一致；发布后以精确版本从 npm 重新安装并重复 `--version` 与 `doctor --offline` 冒烟 | 不发布 GHCR image、skill snapshot 或第二种安装入口；缺少 registry 回读时只能称为 tarball 候选，不能称为已发布验证完成 |

## 门槛关系

### 1. 本地合同门槛

以下两项在普通、无 Provider/release secrets 的 PR CI 中必须同时通过：

- 本地 fixtures；
- 30 票合同测试。

这只证明新实现可以进入真实项目验证，不足以删除当前实现或发布 npm。

### 2. 替代当前实现门槛

必须同时满足：

- 本地合同门槛通过；
- 课程项目迁移通过；
- 同一课程项目完成至少三次真实自动 Continuation Runs 的 dogfood；
- 候选分支上的完整新测试全部通过；
- 旧实现边界盘点中列为“上游取代”或“直接删除”的 exports、源码、依赖、tests、workflows 与文档已从候选移除；
- `npm pack --dry-run --json` 不再包含旧发布面。

达到此门槛后，新实现才可以在一次明确变更中替代当前实现。此前保留旧实现只为对照，不为它增加兼容 shim、feature flag 或双运行模式。

### 3. npm 发布门槛

必须同时满足：

- 替代当前实现门槛通过；
- 发布 workflow 从精确候选 commit 构建唯一 npm tarball；
- 发布凭据只进入最终 `npm publish` job/step，前置验证不持有发布凭据；
- tarball 安装冒烟通过；
- 精确 SemVer tag 指向候选 commit，`package.json` 版本与 tag 相同；
- 发布后从 npm registry 回读并安装同一精确版本，冒烟通过。

MVP 不把 GitHub Release、GHCR、provenance/SBOM、canary channel、自动回滚或多平台安装矩阵设为发布前置。npm 发布是不可逆的外部动作，仍由维护者在门槛全绿后明确触发。

## 最小证据记录

不建设新的 evidence schema 或长期账本。一次候选只需在实施 PR 或发布检查单中记录：

- 候选 commit SHA；
- 本地合同 CI run URL；
- 课程项目安装 PR、固定 base SHA 与 CI run URL；
- 首次 run 和至少三个自动 Continuation Run URL；
- Integration Branch、draft PR、四个工作单元对应的 Issue 与 completion commit；
- `npm pack` CI run URL；
- 发布后 npm 精确版本与安装冒烟 run URL。

GitHub Actions logs、GitHub Issues/commits/PR 与 npm registry 是可观察事实源。Job artifact 只保存脱敏的测试报告或 summary，不保存 raw Agent stream、token、完整环境变量或 Provider response。

## 不作为 MVP 门槛

以下能力属于当前实现已决定删除的产品边界，不能继续成为新实现的 release blockers：

- adopt、managed upgrade、rollback、uninstall 和 legacy lifecycle dogfood；
- Python/Node/Go/Java runtime adapters 与旧 9-fixture matrix；
- remote doctor、credential broker、自建 egress proxy 和 Agent GitHub token；
- Batch checkpoint/control plane、长期 evidence ledger 与双轴两轮 Final Review；
- GHCR control-plane image、skill snapshot、四分发物 parity 和 `0.1.x -> 1.0.0` 迁移 gate。

如果未来重新需要其中任何一项，应另开需求与决策，不在本次重构中预留机制。

## 一句话结论

**新实现先以多类型本地 fixtures 和一次 30 票无凭据合同测试证明协议，再用课程项目的一次 fresh 安装和至少三次真实自动 Continuation Runs 证明可替代性，最后只对同一候选的唯一 npm CLI 做 pack、安装、发布与 registry 回读；除此之外不保留旧发布体系。**
