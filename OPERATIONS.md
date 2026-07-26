# Sandcastle Queue 运维手册

## 产品边界

Setup 只安装 Queue Template。上游 `@ai-hero/sandcastle` 负责 Agent、sandbox、worktree 与 provider runtime；目标项目负责审阅和维护安装后的 Project-controlled Assets。

公开 CLI 只有：

```text
sandcastle-queue init --config <path>
sandcastle-queue doctor [--offline] [--json]
sandcastle-queue --help
sandcastle-queue --version
```

旧 Batch、managed lifecycle、runtime adapters、credential broker、root control-plane image、remote doctor 与多制品 release 均不属于当前产品。

## 前置条件

- Node.js `22.x` 与 npm
- Git repository，工作区和 index 在确认安装前保持稳定
- GitHub.com `origin`
- 配置 GitHub resources 时提供 `GITHUB_TOKEN` 与 `GITHUB_REPOSITORY`

## 配置

配置必须符合 [`schema/mvp-config.schema.json`](./schema/mvp-config.schema.json)。示例：

```json
{
  "schemaVersion": 1,
  "repository": {
    "baseBranch": "main",
    "integrationBranch": "sandcastle/integration"
  },
  "queue": {
    "readyLabel": "ready-for-agent",
    "ownershipLabel": "sandcastle"
  },
  "runner": {
    "runsOn": "ubuntu-latest"
  },
  "commands": {
    "bootstrap": [{ "argv": ["npm", "ci"] }],
    "test": [{ "argv": ["npm", "test"] }],
    "verification": [{ "argv": ["npm", "run", "typecheck"] }]
  },
  "models": {
    "ticket": "gpt-5.6-sol",
    "finalReview": "gpt-5.6-sol",
    "finalFix": "gpt-5.6-sol"
  },
  "execution": {
    "hostFinalizationReserveMinutes": 15
  }
}
```

命令必须是直接 `argv`，不经过 shell。base 与 integration branch 必须不同，未知字段会被拒绝。

## 安装

在目标仓库运行：

```bash
node /path/to/setup-sandcastle-queue/dist/cli.js init \
  --config /path/to/queue-config.json
```

流程分为两个独立确认边界：

1. CLI 显示将创建的完整 patch；输入 `yes` 后才原子写入 Project-controlled Assets。
2. 若发现 provider credentials，CLI 预览 repository labels、Secret 与 Variable；再次输入 `yes` 后才写 GitHub resources。已有 Secret 默认保留，只有明确输入 `overwrite-secret` 才替换。

安装只接受全新目标或与模板完全一致的目标；部分安装和路径冲突 fail closed。确认期间 HEAD、branch、index 或目标内容变化会拒绝写入。没有 adopt、upgrade、rollback 或 uninstall 旁路。

## GitHub repository 配置

Queue workflow 从 repository scope 读取：

- Actions Secret：`ANTHROPIC_AUTH_TOKEN`
- Actions Variable：`ANTHROPIC_BASE_URL`
- 可选 model variables：`ANTHROPIC_DEFAULT_MODEL`、`ANTHROPIC_DEFAULT_FABLE_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`
- 可选 display-name variables：`ANTHROPIC_DEFAULT_FABLE_MODEL_NAME`、`ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME`、`ANTHROPIC_DEFAULT_OPUS_MODEL_NAME`、`ANTHROPIC_DEFAULT_SONNET_MODEL_NAME`
- 可选 runtime variables：`CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、`CLAUDE_CODE_EFFORT_LEVEL`、`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`、`CLAUDE_CODE_NEW_INIT`、`ENABLE_TOOL_SEARCH`

不要为这些值选择 GitHub Environment。`GITHUB_TOKEN` 仅供 Host 执行 Issues、branch、commit、PR 与 continuation 操作，不进入 Agent 或 sandbox。

## 检查与启动

本地只读检查：

```bash
node /path/to/setup-sandcastle-queue/dist/cli.js doctor --offline --json
```

提供 `GITHUB_TOKEN` 与 `GITHUB_REPOSITORY` 后，省略 `--offline` 可检查 labels、Secret 与 Base URL Variable 是否存在。doctor 不验证 provider token 有效性，也不启动 Queue。

维护者通过 Actions 手动 dispatch `Sandcastle Queue` workflow，并选择 `start`。只有同时具备 ready/ownership labels、无 assignee 且无打开 blocker 的 Ticket 才会进入 Frontier。后续 `continue`、Final Review、唯一 Final Fix 和 Final Rereview 由 Host 按远端事实自动接力。

## 安全与恢复

- raw Agent stream 使用 `0600` 临时文件并在成功或失败后删除；audit 只保存 allowlisted、脱敏字段。
- Agent 不接收 `GITHUB_TOKEN`；未列入白名单的宿主环境变量不会透传。
- completion commit、Issue marker、closure 与 Integration PR 共同构成可恢复的远端 publication facts；不使用本地 checkpoint 或长期 audit ledger 作为恢复状态。
- 冲突、未知 publication、stale HEAD、超时或第二次自动修复需求均 fail closed，交回人工检查。
- Setup 不会替目标项目执行 merge，也不会持续管理已安装文件。

## npm 发布

唯一发布制品是 npm CLI tarball。`.github/workflows/publish.yml` 只接受维护者手动 dispatch，并要求：

- `candidate_sha` 是当前 `main` 的完整 40 位 commit SHA；
- `release_tag` 精确等于 `v<package.json version>`；
- `npm` GitHub Environment 中配置 `NPM_TOKEN` Secret，并建议设置 required reviewers。

workflow 在无发布凭据的 Node.js `22.22.2` job 中运行 typecheck、完整 tests、生成唯一 tarball，并在干净临时项目中验证 `--version`、`--help`、fresh init 与 offline doctor。tarball 和 candidate-bound evidence 通过短期 Actions artifact 交给受保护的 publish job。

`NPM_TOKEN` 只注入 `npm publish` step。发布后 workflow 不带 npm credential 查询 registry、比较 tarball integrity、安装 `setup-sandcastle-queue@<exact version>` 并重复 user-path smoke。workflow 不构建 GHCR image、不创建 skill snapshot，也不要求 GitHub Release。
