# Slave-Zcode / ZCode Subagent

这是一个面向 Windows 的开源 Codex 插件：Codex 负责拆分任务、等待和验收，ZCode 桌面负责在当前项目中执行搜索、编辑、测试和构建。任务会出现在 ZCode 的桌面界面，插件只通过本机回环 CDP 连接桌面服务，不修改 ZCode 安装包，也不复制 API Key。

仓库地址：<https://github.com/Asuka-WILLE/Slave-Zcode>

当前版本：v1.0.0。插件发布版本采用 `1.0.X`，GitHub 使用对应的 `v1.0.X` 标签；适配器不把 ZCode 应用版本作为运行门槛，而是检查实际调用所需的桌面接口和消息协议。ZCode 3.12.1 是当前已完成回归的历史环境，其他版本仍需通过目标机器上的接口检查。

## 目录

- 它解决什么问题
- 使用前准备
- 安装插件
- 启动桌面桥接
- 第一次任务
- 模型选择
- 权限、接管与停止
- 九个工具
- 任务状态和恢复
- 诊断与故障处理
- 从源码开发
- 安全边界
- 已知限制

## 它解决什么问题

直接让两个桌面代理同时修改同一个目录，容易产生重复任务、覆盖和无法确认的结果。这个插件把一次委派建模成一个持久化任务：

1. 插件检查 ZCode 连接、实际桌面接口和项目占用。
2. 插件记录任务前的文件基线，并使用稳定 request_id 去重。
3. ZCode 创建真正的桌面会话，任务在 ZCode 界面可见。
4. Codex 通过游标读取状态、摘要、权限请求、最终回复、命令输出和文件变化。
5. 任务结束后，Codex 仍需按原验收条件检查结果；“ZCode 已完成”不等于需求一定正确。

同一项目在插件数据库中同时只能有一个未终止委派任务。这个记录不能阻止其他编辑器或终端修改文件，所以委派期间 Codex 应暂停对该项目的写入、格式化和构建。

## 使用前准备

需要：

- Windows 10/11；
- ZCode 桌面，已在其中配置好 Coding Plan 或第三方 API；
- Node.js 24 或更高版本；
- 支持 `plugin marketplace`、`plugin add` 和 `plugin list` 的 Codex CLI；只安装桌面 App 不一定会把 CLI 命令加入外部 PowerShell 的 `PATH`；
- 项目目录的绝对路径。

插件沿用 ZCode 中已经配置的模型通道。API Key、Cookie 和账号登录状态都留在 ZCode，不要写入 prompt、.mcp.json 或 Issue。

## 安装插件

如果由能够执行 PowerShell 和 Codex CLI 的智能体负责安装，请先阅读 [install for agent.md](./install%20for%20agent.md)；它包含幂等安装、来源冲突检查、验证和桌面桥接边界。

### 方式 A：从 GitHub 添加仓库市场

这是普通使用者推荐的方式。打开 PowerShell，执行：

~~~
codex plugin marketplace add https://github.com/Asuka-WILLE/Slave-Zcode.git
codex plugin add zcode-subagent@slave-zcode
codex plugin list
~~~

codex plugin list 应显示 zcode-subagent 已安装并启用。仓库内的 .agents/plugins/marketplace.json 指向插件根目录；如果 GitHub 仓库使用了其他分支，可以在第一条命令中增加 --ref 分支名。

### 方式 B：从本地源码安装

~~~
git clone https://github.com/Asuka-WILLE/Slave-Zcode.git
Set-Location Slave-Zcode
codex plugin marketplace add (Get-Location).Path
codex plugin add zcode-subagent@slave-zcode
~~~

如果本机已经存在同名市场，使用 codex plugin list 确认实际市场名，再把 @slave-zcode 换成那个名称。源码更新后，在仓库目录执行 npm ci; npm run bundle，然后重新安装或按 Codex 的本地插件更新流程刷新缓存。

### 方式 C：仅运行 MCP 服务进行开发

这种方式不会让 Codex 自动发现 Skill，但便于调试服务：

~~~
npm ci
npm run bundle
node bundle/server.mjs
~~~

Codex 的插件配置由 .mcp.json 提供；其中 cwd: "." 要求服务从插件根目录启动。不要把 node_modules 或用户数据目录复制进发布包。

## 启动桌面桥接

为了让插件连接 Electron 的本机调试端口，必须先正常退出所有 ZCode 窗口和正在运行的 ZCode 任务。插件会自动检查正在运行的进程、Windows 卸载注册信息、`PATH`、开始菜单快捷方式以及常见的用户/系统目录。然后在源码或已安装插件根目录执行：

~~~
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-zcode.ps1
npm run doctor
~~~

启动脚本发现已有 ZCode 进程或端口被占用时会直接拒绝，不会强制杀进程。默认地址是 http://127.0.0.1:19222，只接受回环地址。多个窗口时可以设置目标窗口 ID：

~~~
$env:ZCODE_TARGET_ID = '从 doctor 或 /json/list 得到的 page ID'
~~~

诊断输出中的 desktop_connected: true、renderer page，以及 zcode_health 返回 connected: true 才表示桥接入口和已检查的桌面接口可用。它不表示模型已登录、任务一定能执行或项目已通过测试。

## 第一次任务

安装并启动桥接后，新建一个 Codex 对话。可以明确指定模型：

> 使用 ZCode 的 TokenDance / glm-5.3-flash，完成当前项目的跨文件修复；保留已有修改，只运行指定测试，不提交 Git，结束后报告实际变更和验证结果。

插件 Skill 会在适合时自动委派；小范围文字修改、单条已知命令或缺少关键上下文的工作通常由 Codex 直接完成。委派任务描述应包含目标、相关文件、现象证据、允许的范围、验收命令和是否已有提交/推送授权。

调用流程是：

~~~
zcode_health → zcode_list_tasks → zcode_list_models
        ↓
zcode_start_task → zcode_wait_task / zcode_get_task
        ↓
权限审查或 zcode_send_message → 最终结果审查
        ↓
必要时 zcode_stop_task，或在原任务上继续修正
~~~

zcode_start_task 会立即返回插件任务 ID，后台完成桌面会话创建、任务登记和首条消息发送。不要因为一次 MCP 超时就换新的 request_id；先用原 ID 查询。

## 模型选择

先调用 zcode_list_models，它只返回 provider 名称、模型 ID、允许的推理强度和当前首选项，不返回配置对象或凭据。创建时可以传：

~~~json
{
  "workspace_path": "C:\\work\\my-project",
  "title": "修复并测试登录流程",
  "prompt": "修复现有错误并运行项目测试。保留用户改动，不提交 Git。",
  "request_id": "login-fix-2026-09-14-001",
  "model_selection": {
    "providerId": "a87e3f70-c329-4b51-9a2a-840e23dab901",
    "modelId": "glm-5.3-flash",
    "options": { "reasoningLevel": "low" }
  }
}
~~~

providerId 和 modelId 必须来自当前目录；不要猜测或把模型名称改成大小写不同的字符串。省略 model_selection 时，插件在创建时读取 ZCode 的首选模型，并把当时的选择保存到任务中；不会修改 ZCode 全局默认值。模型要求推理强度而调用方未填写时，插件从该模型允许值中选择默认项。

## 权限、接管与停止

### 权限请求

ZCode 需要执行高风险 Shell、写文件或其他工具时，任务会变为 waiting_for_input，返回 pending_permissions。每项包含完整工具输入、请求 ID 和指纹。Codex 必须先检查命令是否属于用户授权的项目范围，再调用 zcode_resolve_permission，并传入原指纹。一次放行只对应一次请求，不会自动创建全局放行规则。

没有明确授权时，让用户在 ZCode 桌面处理；提交、推送、部署、删除无关数据等动作不会因为“开发任务”四个字自动获得授权。

### 人工接管

只查看任务不会改变控制权。插件观察到无法归属于自身的用户消息、运行模式变化或外部停止后，会把 control_owner 标记为 user，继续读取但停止自动追加指令。用户明确要求 Codex 接回任务后，才可以在 zcode_send_message 中使用 take_control: true。

### 停止

zcode_stop_task 只发送停止请求，不杀 ZCode 进程，也不回滚文件。任务先进入 stopping，只有后续读取到桌面非活动状态才变为 stopped。等待超时不会触发停止；如果桌面连接断开，状态可能暂时是 unknown，此时不要重发原任务。

## 九个工具

| 工具 | 必要参数 | 说明 |
| --- | --- | --- |
| zcode_health | 无 | 检查安装版本、本机 CDP、传输和权限模式 |
| zcode_list_models | 无 | 列出已配置通道、模型和推理强度，不返回凭据 |
| zcode_start_task | workspace_path、title、prompt、request_id | 创建桌面任务并立即返回；可选 model_selection |
| zcode_get_task | task_id | 刷新任务状态、权限请求、摘要和结果 |
| zcode_wait_task | task_id | 按 after_cursor 等待，默认 25 秒，最长 30 秒 |
| zcode_send_message | task_id、message、request_id | 当前轮结束后续接；未确定的发送不会重放 |
| zcode_resolve_permission | task_id、request_id、fingerprint、allow | 审查后只解决一个当前权限请求 |
| zcode_stop_task | task_id | 请求停止并等待确认 |
| zcode_list_tasks | 可选 workspace_path | 列出插件数据库中的任务缓存 |

所有工具返回结构化 JSON。错误对象包含 code、message 和 retryable。常见错误包括 ZCODE_NOT_FOUND、DESKTOP_UNAVAILABLE、DESKTOP_INTERFACE_UNAVAILABLE、WORKSPACE_BUSY、USER_CONTROL、OUTCOME_UNKNOWN、ZCODE_AUTH_REQUIRED 和 ZCODE_EXECUTION_FAILED。

## 任务状态和恢复

任务记录保存在 %LOCALAPPDATA%\\zcode-subagent\\tasks.sqlite，包括插件任务 ID、ZCode session ID、请求去重、事件游标、文件基线和验收结果。数据库不保存完整 ZCode 会话，也不保存 API Key。

状态含义：

- queued：已占用项目，等待桌面创建或下一轮开始；
- running：桌面正在执行；
- waiting_for_input：存在权限或其他待处理请求；
- completed：读取到完整结束证据；
- failed：读取到模型/协议/执行错误；
- stopping：停止命令已发出，尚未确认；
- stopped：读取到非活动停止状态；
- unknown：连接或初始化结果不确定，禁止自动补发。

重启 MCP 服务后，已保存 session ID 的任务可以继续 get/wait。创建阶段如果在拿到 session ID 之前失联，插件不会猜测或重建任务，而是保留 unknown，需用户在 ZCode 中核对。

## 诊断与故障处理

### ZCODE_NOT_FOUND

插件会优先从正在运行的 ZCode 进程和 Windows 注册信息取得安装根目录，再检查 `PATH`、开始菜单快捷方式以及 `C:\Program Files`、`%LOCALAPPDATA%\Programs` 等常见目录。普通安装不需要手动填写路径。自定义或便携版安装没有出现在这些来源中时，才设置：

~~~
$env:ZCODE_INSTALL_DIR = 'D:\Apps\ZCode'
npm run doctor
~~~

### `codex` 不是命令或 `plugin add` 不存在

这类错误发生在插件安装之前，表示当前 PowerShell 没有找到可用的 Codex CLI，或者找到的 CLI 版本还没有插件子命令。桌面 App 内置的运行时路径可能只在集成终端会话中临时加入 `PATH`，不会自动出现在另一个 PowerShell 窗口里。

在外部 PowerShell 中按官方安装脚本安装或更新当前用户的 Codex CLI：

~~~powershell
irm https://chatgpt.com/codex/install.ps1 | iex
~~~

安装完成后关闭当前 PowerShell，重新打开一个窗口，再确认命令和子命令：

~~~powershell
Get-Command codex
codex --version
codex plugin --help
~~~

`plugin --help` 至少应列出 `marketplace`、`add` 和 `list`。如果刚安装的命令仍未被发现，可在当前窗口临时补充官方默认安装目录后重试：

~~~powershell
$codexInstall = Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\bin'
if (-not (Test-Path (Join-Path $codexInstall 'codex.exe'))) {
  throw "Codex CLI was not found in $codexInstall"
}
$env:Path = "$codexInstall;$env:Path"
Get-Command codex
codex plugin --help
~~~

确认 CLI 可用后，只复制下面的纯文本命令。不要把 Markdown 链接的 `[文字](地址)` 一起复制，也不要在 `@` 前加反斜杠：

~~~powershell
codex plugin marketplace add "https://github.com/Asuka-WILLE/Slave-Zcode.git"
codex plugin add "zcode-subagent@slave-zcode"
codex plugin list
~~~

如果你只在 Codex 桌面 App 的集成终端中运行这些命令，请先在同一个终端执行 `codex plugin --help`；确认该会话确实包含 `add` 和 `list` 后，再执行安装。不要把带有随机目录名的桌面内部 CLI 路径永久写入 `PATH`，桌面更新后该路径可能变化。

### DESKTOP_UNAVAILABLE 或 DESKTOP_TARGET_REQUIRED

正常关闭 ZCode 后重新运行 scripts/start-zcode.ps1。如果有多个 renderer page，用 npm run doctor 输出的 page ID 设置 ZCODE_TARGET_ID。不要让脚本强行结束已有 ZCode 进程。

### DESKTOP_INTERFACE_UNAVAILABLE

当前桌面缺少适配器实际需要的服务或方法。记录错误中列出的服务方法，先确认目标 ZCode 是否已完成渲染，再更新适配器与测试；不要把版本号当作接口兼容性的替代证明。

### WORKSPACE_BUSY

先用 zcode_list_tasks 找出该项目的未终止任务，使用 zcode_get_task 查看状态。不要在任务仍运行时创建第二个写任务；如果确实需要接手，先在 ZCode 中结束或停止原任务。

### waiting_for_input

读取 pending_permissions 的完整命令。确认它只涉及任务范围且已有用户授权后，使用原 request_id 和 fingerprint 单次解决；否则让用户在 ZCode 中处理。

### unknown

unknown 代表结果没有被证实，不等于失败。检查 ZCode 桌面、再用原任务 ID 调用 zcode_get_task。不要换一个请求 ID 重新提交同一个需求。

### 模型初始化失败

如果提示推理强度缺失，重新调用 zcode_list_models，按当前模型的 reasoning_levels 传 model_selection.options.reasoningLevel。如果账户通道需要验证，插件会返回真实错误，不会绕过验证或把错误伪装成成功。

## 从源码开发

~~~
git clone https://github.com/Asuka-WILLE/Slave-Zcode.git
Set-Location Slave-Zcode
npm ci
npm run check
npm test
npm run bundle
npm run verify:mcp
~~~

源码结构：

~~~
src/mcp/                         MCP 工具注册与生命周期
src/tasks/                       状态机、租约、去重、文件结果
src/storage/                     SQLite 任务和操作记录
src/adapters/zcode-desktop/      ZCode desktop 接口适配器
src/results/                     文件基线和变化清单
skills/zcode-delegation/         Codex 自动委派规则
scripts/                         诊断、CDP 探针、打包和验收脚本
bundle/server.mjs                发布时使用的单文件 MCP 服务
~~~

提交前至少运行 npm run check、npm test 和 npm run bundle。bundle/server.mjs 是发布文件，源码变化后要重新生成。不要提交 node_modules/、dist/、.runtime/、analysis/ 或 SQLite 运行数据。协议样本必须去除账号、Cookie、路径中的个人信息和项目内容。

## 安全边界

- CDP 只允许 http://127.0.0.1、localhost 或 [::1]，拒绝认证信息、查询参数和外部主机。
- 桌面服务调用使用固定方法白名单，输入通过 JSON 序列化进入浏览器上下文，不能把工具参数当作任意 JavaScript 执行。
- 插件只调用已验证的桌面服务，不修改 app.asar、注册表或 ZCode 全局权限。
- 每个权限请求逐项审查；不支持一键批准全部 Shell 请求。
- 不默认提交、推送、部署、清理或回滚用户文件。
- 文件变化是基线差异，不能自动证明变化一定由本任务产生；如果有外部编辑器同时写入，必须由 Codex 复核。

详见 CONTRIBUTING.md、SECURITY.md 和验证记录。

## 已知限制

当前版本支持当前轮结束后的续接；运行中追加消息、自动任务期限和完整事件流订阅尚未实现。人工在桌面追加消息、切换运行设置和停止长时间工具的完整体验需要在目标机器上继续验证。ZCode 内部协议不是公开稳定 API，升级桌面前请先运行诊断并核对版本记录。

本项目采用 MIT License，见 LICENSE。
