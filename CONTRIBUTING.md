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

## 变更原则

- 不修改 ZCode 的 `app.asar` 或安装目录。
- 不把 API Key、Cookie、会话内容或个人路径写入源码、测试快照或 Issue。
- 桌面协议变化先更新 `src/adapters/zcode-desktop/`，再补兼容性和失败路径测试。
- MCP 工具的请求 ID、未知结果和人工接管语义属于公开契约；改变它们需要更新 README 和验证记录。
- 提交、推送、部署、删除等动作不能被插件任务默认执行。

## Pull Request

PR 描述请包含：用户可见的行为变化、影响的工具或协议、验证命令及结果、尚未验证的桌面或账号条件。不要提交真实会话日志；如需协议样本，请脱敏并只保留最小字段。
