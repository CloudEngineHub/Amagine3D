# 参与 Amagine3D 开发

> **English**: [View the English version](./CONTRIBUTING.md)

需要先讨论设计方案的改动，可使用 [RFC 模板](../doc/RFC_TEMPLATE.md) 创建 issue。
使用 `RFC: 提案标题` 作为 issue 标题，将模板各章节复制到正文，并替换占位内容。

## Issue 状态与后续处理

每个未关闭的 issue 保留一个状态标签，与 `bug`、`enhancement`、`documentation`
等类型标签分别使用：

| 标签 | 含义 |
| --- | --- |
| `status: needs-triage` | 尚未经过维护者分类。 |
| `status: discussion` | 等待讨论问题或方案，尚未形成结论。 |
| `status: planned` | 已接受并列入计划，尚未开始实施。 |
| `status: in-progress` | 正在实现或修改。 |

**Issue status** 工作流会为没有状态的新 issue、重新打开的 issue 添加
`status: needs-triage`。维护者添加新状态后，旧状态会自动移除；移除最后一个状态
则回到待分类。手动运行此工作流会创建缺失的标签，并按相同规则处理已有的未关闭
issue；机器人不会根据正文自行判断是否已承诺开发。

只有 `status: discussion` 不会触发自动关闭。维护者明确要求提问者补充信息后，
可额外添加 `needs-info`，收到足够信息后应移除它。离开讨论状态时，机器人会自动
移除 `needs-info` 和 `stale`。

**Stale issues** 工作流每天检查一次，只处理同时带有 `status: discussion` 和
`needs-info` 的 issue：连续 30 天没有活动则提醒，再过 14 天仍无活动则关闭。
评论或更新会重置闲置计时；关闭前恢复活动时，下次检查会移除已有的 `stale`
标签。带有 `no-stale`、已分配负责人、已纳入里程碑，或带有待分类、已列入计划、
正在修改状态的 issue 均豁免。PR 不参与自动关闭。闲置关闭记为 `not_planned`，
不表示问题已经修复；提问者仍可评论补充信息，并请维护者重新打开。

**初始阶段仅试运行。** 仓库的 Actions 变量 `STALE_ISSUES_ENABLED` 不为 `true`
时，闲置检查只输出日志，不修改 issue 标签、不发评论、不关闭 issue。要启用每日
实际处理，在 **Settings → Secrets and variables → Actions → Variables** 中
将该变量设为 `true`。手动运行默认 `dry_run: true`，实际执行还需同时将
`dry_run` 设为 `false`。删除变量或将其设为 `false` 即可恢复预览模式。
状态标签的自动维护不受此开关影响。

## 开发

了解 CAD 流程可先阅读 [以证据为依据的修复流程概览](./cad-workflow.zh-CN.md)，
其中说明了修复决策的归属、运行时的检查，以及如何理解修复进展。

使用 Node.js 22.19.0 或更新版本、Python 3.10 至 3.13 和 npm。

```bash
npm ci
npm run python:setup
npm run typecheck
npm test
npm run test:python
npm run build
```

PNG 证据图使用由 trimesh、NumPy 和 Pillow 实现的无界面 CPU Z-buffer。
四个视图默认在单进程内串行渲染。运行
`npm run benchmark:renderer` 可记录小型、中型和较大 STL 的
耗时、峰值内存与三角形数量。四视图默认输出 640 像素并使用 1×，2× 超采样需显式开启。
这条基于 `pathlib` 的单进程链路在 CI 中覆盖 Ubuntu 和 Windows，macOS
使用相同的无界面代码路径。

请保持浏览器代码与本地 API 之间的边界。React 不得直接访问模型凭据、Codex
状态、产品会话记录、上传目录或 session 工作区。服务端产物路由必须把所有路径
限制在所选 session 的 `workspace/sessions/<sessionId>/` 目录内。
只有 `packages/a3d-runtime` 可以导入 `@openai/codex` 或
`@openai/codex-sdk`；应用服务端必须使用该 package 的公共运行时契约，运行时
package 也不得反向导入 `server/` 或 `src/`。

每次提交一个聚焦的改动，并为新的公开行为附带测试和文档。自动化测试
不得调用真实模型提供商。连接真实提供商的 CAD 运行属于手动检查，不得提交
凭据、私有提示词、上传文件、生成工作区或不稳定的黄金文本。不要提交 `.env`、
`.amagine-state/`、`workspace/` 和 `.venv/`。

对于 UI 改动，请记录浏览器版本、精确路由、截图或产物证据，以及已知局限。
修改 skill 或 CAD 执行流程时，应补充覆盖发现、路径隔离和产物验证的聚焦测试。
安全问题请遵循 [`SECURITY.zh-CN.md`](./SECURITY.zh-CN.md)，而不是通过公开 issue 上报。
