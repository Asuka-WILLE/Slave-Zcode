# 参与贡献

感谢你改进 ZCode Subagent。提交代码前，请先在 Issue 中说明问题或提案；涉及 ZCode 私有桌面接口的变更，需要同时写明适用的 ZCode 版本和可复现证据。

## 本地开发

要求 Node.js 24 或更高版本。克隆仓库后执行：

```powershell
npm ci
npm run check
npm test
npm run bundle
```

提交前确认 `git status` 只包含本次改动。`dist/`、`node_modules/`、`.runtime/`、`analysis/` 和 SQLite 运行数据不应提交；`bundle/server.mjs` 是插件安装需要的分发文件，应在源码变更后重新生成并纳入提交。

## 版本与更新日志

发布版本固定使用 `1.0.X` 的语义化版本格式，首个 V1 发布为 `1.0.0`。插件 manifest、`package.json`、`package-lock.json`、MCP server 和安装说明中的版本必须保持一致；GitHub 上为每个发布提交创建对应的带注释标签 `v1.0.X`。

每次面向用户的改动都要在 [CHANGELOG.md](./CHANGELOG.md) 写入一条记录。发布时新增 `## v1.0.X - YYYY-MM-DD` 段落，说明行为变化和验证结果；`npm run check` 会校验版本字段、发布 bundle 和当前版本日志是否同步。

发布流程：更新版本字段和 CHANGELOG，运行 `npm run check`、`npm test`、`npm run bundle`，确认 `git diff --check` 和工作区范围，再提交并创建标签：

```powershell
git commit -m "release: v1.0.X"
git tag -a v1.0.X -m "Release v1.0.X"
git push origin main
git push origin v1.0.X
```

标签推送后，GitHub 的提交页和 Releases 页面会显示对应版本；CI 结果以该提交的检查页为准。版本号升级不代表桌面 ZCode 版本已经被验证，桌面接口证据仍需写入验证记录。

## 变更原则

- 不修改 ZCode 的 `app.asar` 或安装目录。
- 不把 API Key、Cookie、会话内容或个人路径写入源码、测试快照或 Issue。
- 桌面协议变化先更新 `src/adapters/zcode-desktop/`，再补兼容性和失败路径测试。
- MCP 工具的请求 ID、未知结果和人工接管语义属于公开契约；改变它们需要更新 README 和验证记录。
- 提交、推送、部署、删除等动作不能被插件任务默认执行。

## Pull Request

PR 描述请包含：用户可见的行为变化、影响的工具或协议、验证命令及结果、尚未验证的桌面或账号条件。不要提交真实会话日志；如需协议样本，请脱敏并只保留最小字段。
