# 验证记录（2026-09-14）

历史回归环境：Windows；ZCode 3.12.1；内置 CLI 0.16.5；Node.js 24.14.1。

## 已实测

- CDP 连接到正在运行的桌面，通过 React App 的 services 读取真实任务/会话服务；未修改安装包。
- 同一 session 经 createSession → createTask → renameTask 登记，调用桌面工作区打开回调后在侧栏出现。观察读取复用该 session ID。
- 配置目录读取到 BigModel Start Plan、deepseek、TokenDance；返回模型 ID 和推理选项，未复制凭据。
- TokenDance / glm-5.3-flash / low 的只读任务完成，实际回复 `ZCODE_MODEL_OK`，无文件变化。
- 跨文件开发：在隔离的 `.runtime/development 中文` 目录完成任务（真实 session ID 不写入仓库）。修正 math.mjs 的减法错误，保留原注释，并在 math.test.mjs 加入四个测试；实际 `node --test math.test.mjs` 为 5 pass / 0 fail。父任务逐文件核对，插件变化清单恰好包含两文件。
- 开发命令出现原生权限请求，插件返回完整 Bash 输入与指纹；审阅后 resolveInteraction 选择 allow_once，任务继续完成。未新增全局/项目放行规则。
- 对已有只读任务续接请求后，发送 stop，读取状态为 stopped。该轮模型已快速结束，故此证据确认停止命令与状态读取，不证明长时间工具进程一定被中断。
- 独立 Node MCP 客户端启动 bundle/server.mjs，完成初始化、列出 9 个工具、health、list_models 和不存在任务的结构化错误返回。
- 每次验收脚本重建管理器并打开同一 SQLite，成功按原 session ID 继续读取；未重建桌面任务。
- 19 项自动化测试通过：除既有的并发去重、请求冲突、项目占用、失联不重发、等待不取消、停止幂等、接管约束、租约、错误投影、文件基线、参数边界、旧结果防误判、续接占用回滚、权限指纹、初始化竞态外，还覆盖安装路径手动覆盖、注册信息与 `PATH` 候选及版本优选、无候选诊断、开始菜单快捷方式候选。

## 发现并处理的问题

默认账户通道曾返回 `Captcha verification request timed out`。用户没有看到验证提示，未据此判断账号失效；改用用户已配置的指定通道验收。第三方模型最初缺少 reasoningLevel，在初始化前被拒绝；已补模型选项解析，并把 projection.lastError 纳入错误返回。

## 证据边界与后续验收

- 人工在桌面点击追加、切换设置与停止的完整流程尚未由用户实测；控制权规则目前有协议字段证据和自动化测试。
- 当前支持轮结束后续接，运行中追加、自动任务期限和完整事件流订阅待后续版本。
- 桌面关闭时的连接错误路径有实现，未为了测试而关闭用户正在使用的窗口。
- 适配器按运行时接口和消息协议判断是否可调用；3.12.1 只是本记录的历史回归环境。文件变化不能归属同时编辑的其他进程。
- 安装后需新建 Codex 对话确认 Skill 与 MCP 的实际发现；已有对话不会自动获得新工具。
- 插件启动脚本会自动发现 ZCode 安装根目录；解析顺序为正在运行的进程、Windows 卸载注册信息、`PATH`、开始菜单快捷方式和常见用户/系统目录。自定义或便携版安装仍可通过 `ZCODE_INSTALL_DIR` 或 `-InstallDir` 指定。`stage-plugin.mjs` 会把解析器与诊断脚本一起复制到安装目录。
- 仓库根目录的 `slave-zcode` 市场清单已通过本机 `codex plugin marketplace add` 与 `codex plugin add zcode-subagent@slave-zcode` 验证；推送后通过 GitHub raw 地址确认 `README.md`、`.codex-plugin/plugin.json`、`.agents/plugins/marketplace.json` 和 `package.json` 可读取。尚未在远端仓库缓存上重复执行插件安装，远端安装仍应由使用者在目标 Codex 环境中确认。

## 桌面接口备忘

command envelope 使用渲染器现有 clientId，通过 helloConversationV4 / initializeConversationV4（protocolVersion 3）握手。命令类型包括 createSession、sendText、stop、resolveInteraction。sendText 的 ACK 可能没有 messageId，使用用户消息 metadata.inputIntent.sourceCommandId（或 conversationInputIntent）识别来源。会话快照来源 zcodeSessionService.readSession；状态、activeTurnId、pendingRequestIds、消息完成时间共同决定结果，不能以一段文本判定完成。

原始验收材料保存在源码 `.runtime`，不随安装包分发；复跑脚本不会自动重复 start。要运行新验收，应明确更换逻辑 request_id 和独立目录。

安装确认：`codex plugin add zcode-subagent@personal` 成功，`codex plugin list` 显示 installed, enabled。安装缓存 bundle 已经独立 MCP 客户端验证。
