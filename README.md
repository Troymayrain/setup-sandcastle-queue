# setup-sandcastle-queue

`setup-sandcastle-queue` 把 Sandcastle Queue 的安装、runtime 检测、GitHub 配置、安全边界和运维检查收进同一个版本化工具。它不会替目标仓库执行 `stash`、`reset`、`commit` 或 `push`。安装文件先形成完整 patch，维护者确认同一个 `planHash` 后才会写入。

> 当前源码是开发中的 `0.1.0`。installer、runtime adapters、credentialless CI 和 release-gate 验证器已有自动化覆盖；managed workflow 引用的 `sandcastle-queue workflow-host` 尚未实现，因此真实 Batch Actions 链路目前会 fail closed。不要把当前版本用于生产 Batch，也不要把尚未运行的 live E2E、发布或 dogfood gate 记为成功。

完整配置、安全模型、状态语义和恢复步骤见 [维护者手册](./OPERATIONS.md)。

## Quickstart

需要 Node.js `22.22.2`、npm `10.9.7`、Git 和一个带 GitHub.com `origin` 的目标仓库。先在本仓库构建 CLI：

```bash
npm ci --ignore-scripts
npm run build
node dist/cli.js version
```

进入目标仓库后，用构建产物的绝对路径执行命令。下面以 `/path/to/setup-sandcastle-queue/dist/cli.js` 表示该路径。

```bash
node /path/to/setup-sandcastle-queue/dist/cli.js propose
node /path/to/setup-sandcastle-queue/dist/cli.js validate-config \
  --config /tmp/sandcastle-config.json
node /path/to/setup-sandcastle-queue/dist/cli.js plan \
  --config /tmp/sandcastle-config.json \
  > /tmp/sandcastle-plan-output.json
jq '.result' /tmp/sandcastle-plan-output.json > /tmp/sandcastle-plan.json
```

检查 `/tmp/sandcastle-plan-output.json` 中的完整 `patch`、`installationState` 和 `planHash`。确认后再应用同一份 plan：

```bash
node /path/to/setup-sandcastle-queue/dist/cli.js install \
  --plan /tmp/sandcastle-plan.json \
  --confirm "$(jq -r '.planHash' /tmp/sandcastle-plan.json)"
node /path/to/setup-sandcastle-queue/dist/cli.js doctor --offline
```

`doctor --offline` 不需要 GitHub 或 provider 凭据。GitHub resources 仍需单独预览、逐类确认和人工复核，详见维护者手册。

## 安装入口

仓库根同时是 setup skill package。支持 Agent skill 的环境应通过 `SKILL.md` 调用 `node scripts/setup.mjs`，npm CLI 和 setup skill 都委托给同一个 installer core。`0.1.0` release workflow 与四分发物一致性 gate 已就绪，但尚无真实运行和发布证据，请勿假设 npm、GitHub Release 或 GHCR 中已有可用的 `0.1.0`。

## 开发验证

```bash
npm run typecheck
npm test
```

普通 PR CI 使用九类无凭据 fixture、本地 GitHub 与 Anthropic-compatible contract servers，并验证 Docker build/run。Python 与 Java 的真实 live E2E 只允许 maintainer 手动触发，且成功必须来自专用 fixture repositories 的候选 commit 绑定证据。legacy lifecycle dogfood 同样是 manual-only gate；它要求真实旧仓库返回 release、baseline 与 candidate 绑定的脱敏证据。当前仅验证器和 workflow 合同就绪，尚无成功 dogfood run。

## License

项目使用 MIT License。第三方 runtime skill snapshots 的来源、commit、hash 与 notices 记录在 `THIRD_PARTY_NOTICES.md` 和安装产物中。
