# setup-sandcastle-queue

`setup-sandcastle-queue` 是一个单一用途的 npm CLI：把可审阅、可修改的 Sandcastle Queue Template 安装到目标 GitHub 仓库。Agent 执行、sandbox、worktree 与 provider runtime 由上游 `@ai-hero/sandcastle` 提供；本包不再提供第二套 runtime、兼容 lifecycle 或 library API。

## 支持边界

- `sandcastle-queue init --config <path>`：预览并安装 Project-controlled Assets，可选配置 repository labels、Secret 与 Variables。
- `sandcastle-queue doctor [--offline] [--json]`：检查本地安装；非 offline 模式还检查 GitHub resources 是否存在。
- Queue Template：生成 `.github/workflows/sandcastle-queue.yml`、`.sandcastle/config.json`、prompts 与独立 Queue tool project。

不支持 adopt、upgrade、rollback、uninstall、managed manifest、runtime detection、credential broker、remote doctor、Batch checkpoint 或旧 library exports。安装后的资产归目标项目控制；setup 不持续覆盖或迁移它们。

## 使用

需要 Node.js `22.x`、npm、Git、GitHub CLI，以及一个带 GitHub.com `origin` 的目标仓库。

```bash
npm ci --ignore-scripts
npm run build
node dist/cli.js init --config /path/to/queue-config.json
node dist/cli.js doctor --offline --json
```

`init` 会先显示完整 patch，只有输入 `yes` 才写入项目资产。若提供 provider credentials，它还会单独预览 GitHub resources，并再次要求确认。完整配置与运行说明见 [OPERATIONS.md](./OPERATIONS.md)。

## 开发验证

```bash
npm run typecheck
npm test
npm pack --dry-run --ignore-scripts
```

测试覆盖 CLI、GitHub resource 边界、Node/Python/Mixed 安装合同、Queue Template tool，以及 npm tarball 禁止面。

## License

MIT
