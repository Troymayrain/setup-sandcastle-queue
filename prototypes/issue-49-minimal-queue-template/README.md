# PROTOTYPE — 最小 Queue Template 骨架

> Throwaway prototype for [验证最小 Queue Template 骨架](https://github.com/Troymayrain/setup-sandcastle-queue/issues/49). 不得作为生产实现合并到 `main`。

## 要回答的问题

只依赖上游 Sandcastle、独立 `.sandcastle` 工具子项目、GitHub-hosted 自动接力和通用项目命令的最小骨架，是否足以让维护者理解完整运行流程与定制界面？

本原型刻意不访问 GitHub、不运行 Agent、不持久化状态。它只展示两件事：

1. 项目维护者需要审阅和定制哪些文件；
2. GitHub 远端事实如何驱动一个工作单元及其后继 run。

## 一条命令运行

```bash
node prototypes/issue-49-minimal-queue-template/prototype.mjs
```

非交互演示：

```bash
printf 'dtetrfpq' | node prototypes/issue-49-minimal-queue-template/prototype.mjs
```

## 维护者看到的完整安装形状

```text
template/
├── .sandcastle/
│   ├── package.json          # 独立 Node.js 22 工具子项目；精确依赖上游 Sandcastle
│   ├── queue.config.json     # 唯一项目定制面
│   ├── prompts/              # 三个可审阅、可修改的角色提示词
│   └── src/queue.ts          # 项目控制的薄编排入口（本原型仅列职责）
└── .github/workflows/
    └── sandcastle-queue.yml  # GitHub-hosted、有界、串行自动接力
```

生产模板还会包含前置决策要求的 lockfile、tsconfig、Dockerfile、README、LICENSE、`.env.example`、`.gitignore` 和模板合同测试；这里不复制与判断无关的样板。

## 评审路径

1. 看 `template/.sandcastle/queue.config.json`：确认只有仓库差异可配置。
2. 看 `template/.sandcastle/src/queue.ts`：确认 Queue Template 只编排上游 `run()`，不实现 runtime。
3. 看 `template/.github/workflows/sandcastle-queue.yml`：确认宿主拥有 GitHub 权限，Agent 不获得 GitHub token。
4. 运行 TUI：按 `d` 开始，按 `t` 模拟一票成功，按 `e` 模拟有更多票的接力；清空后用 `r` / `f` / `p` 走 final 阶段。任意阶段按 `w` 查看等待，按 `x` 查看 fail-closed。
