# Install for Agent

这份文件是给能够执行 PowerShell、读取本地文件并调用 Codex CLI 的智能体使用的安装流程。目标是让智能体自主完成 zcode-subagent 插件的安装、验证和桌面桥接准备，同时保留用户已有的插件、市场配置、项目修改和账号状态。

## 执行边界

把本文件当作一份可复现的操作规程，而不是安装成功的证明。每执行一个阶段，都要读取命令输出并记录证据；没有输出证据时，不要向用户报告“已安装”或“已生效”。

执行时遵守以下边界：

- 使用当前插件清单、市场清单、Codex CLI 帮助和实际命令输出作为事实源。
- 安装操作应当幂等。已经注册并指向正确来源的市场不要重复添加，已经安装且启用的插件不要重复安装。
- 不执行 git reset --hard、git clean、删除用户配置、删除插件缓存、杀死 ZCode 进程或关闭用户正在使用的任务。
- 不因为“安装插件”自动获得提交、推送、部署、删除无关数据或修改其他项目的授权。
- 不读取、复制或写入 API Key、Cookie、Token、ZCode 凭据或完整账号配置。
- 需要用户选择来源、处理同名市场冲突、接受登录或处理桌面中的原生确认时，先保留当前状态并报告具体阻塞点。

## 当前插件事实

本仓库的事实值来自 .codex-plugin/plugin.json 和 .agents/plugins/marketplace.json。当前版本的主要值是：

| 项目 | 当前值 |
| --- | --- |
| Git 仓库 | https://github.com/Asuka-WILLE/Slave-Zcode.git |
| 插件名 | zcode-subagent |
| 版本 | 0.1.0 |
| 市场名 | slave-zcode |
| 市场入口 | .agents/plugins/marketplace.json |
| 插件源路径 | ./，相对于市场根目录 |
| 插件选择器 | zcode-subagent@slave-zcode |
| 接口回归基线 | ZCode 3.12.1（历史环境，不是运行门槛） |
| 已要求 Node 版本 | Node.js 24+ |

如果清单中的名称、版本或市场名发生变化，以当前文件读取结果为准，不要继续使用上表中的旧值。codex plugin add 接受的是 插件名@市场名，不能把插件目录直接当成插件参数传入。

## 阶段一：确定插件根目录和安装来源

先找到包含 .codex-plugin/plugin.json 的插件根目录。若智能体已经在本仓库中，使用当前工作目录；若本文件是从其他位置提供的，向上查找包含该清单的目录。不要把 .agents/plugins 目录误当成插件根目录。

~~~powershell
$ErrorActionPreference = 'Stop'

$PluginRoot = (Get-Location).Path
$ManifestPath = Join-Path $PluginRoot '.codex-plugin\plugin.json'
$MarketplacePath = Join-Path $PluginRoot '.agents\plugins\marketplace.json'

if (-not (Test-Path -LiteralPath $ManifestPath)) {
  throw "Plugin manifest not found under $PluginRoot. Locate the repository root before continuing."
}

$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if ($Manifest.name -ne 'zcode-subagent') {
  throw "Unexpected plugin name: $($Manifest.name)"
}

if (Test-Path -LiteralPath $MarketplacePath) {
  $Marketplace = Get-Content -LiteralPath $MarketplacePath -Raw | ConvertFrom-Json
  $MarketplaceName = [string]$Marketplace.name
  $MarketplaceEntry = @($Marketplace.plugins | Where-Object { $_.name -eq $Manifest.name }) | Select-Object -First 1
  if (-not $MarketplaceName -or -not $MarketplaceEntry -or $MarketplaceEntry.source.path -ne './') {
    throw "Marketplace metadata does not point to this plugin root. Inspect $MarketplacePath."
  }
} else {
  $MarketplaceName = 'slave-zcode'
}

$PluginName = [string]$Manifest.name
$PluginSelector = "$PluginName@$MarketplaceName"
Write-Output "PluginRoot=$PluginRoot"
Write-Output "PluginSelector=$PluginSelector"
~~~

安装来源按以下顺序选择：

1. 当前目录有完整清单和市场文件时，优先使用当前本地仓库。这样可以验证刚生成的 bundle/server.mjs，也不会误装另一个同名插件。
2. 没有本地仓库、但用户要求从公开仓库安装时，使用 Git 市场源：https://github.com/Asuka-WILLE/Slave-Zcode.git，默认 ref 为 main。
3. 当前目录只有单独的插件子目录而没有 .agents/plugins/marketplace.json 时，不要把该目录直接传给 codex plugin add。应回到包含市场文件的根目录，或从 Git 仓库重新添加市场。

## 阶段二：检查 Codex CLI

先确认当前 PowerShell 使用的是可执行的 Codex CLI，并且 CLI 具备插件子命令：

~~~powershell
$CodexCommand = Get-Command codex -ErrorAction SilentlyContinue
if (-not $CodexCommand) {
  throw 'Codex CLI was not found on PATH. Install or expose the official Codex CLI, then reopen PowerShell.'
}

codex --version
codex plugin --help
codex plugin marketplace --help
codex plugin add --help
~~~

codex plugin --help 至少应包含 marketplace、add 和 list。如果 CLI 不存在或没有插件子命令，在 Windows PowerShell 中可以使用官方安装入口，然后关闭并重新打开当前终端：

~~~powershell
irm https://chatgpt.com/codex/install.ps1 | iex
~~~

重新打开终端后再次执行 Get-Command codex、codex --version 和 codex plugin --help。不要把 Codex 桌面 App 的随机内部运行时目录永久写入系统 PATH。

## 阶段三：检查现有市场和插件

先读取 JSON 状态，避免重复注册或把已有的其他来源误当成目标插件：

~~~powershell
$MarketplaceState = codex plugin marketplace list --json | ConvertFrom-Json
$InstalledState = codex plugin list --json | ConvertFrom-Json

$ExistingMarket = @($MarketplaceState.marketplaces | Where-Object { $_.name -eq $MarketplaceName }) | Select-Object -First 1
$ExistingPlugin = @($InstalledState.installed | Where-Object { $_.pluginId -eq $PluginSelector }) | Select-Object -First 1

if ($ExistingMarket) { $ExistingMarket | ConvertTo-Json -Depth 10 }
if ($ExistingPlugin) { $ExistingPlugin | ConvertTo-Json -Depth 10 }

if ($ExistingMarket -and (Test-Path -LiteralPath $MarketplacePath)) {
  $ExpectedRoot = (Resolve-Path -LiteralPath $PluginRoot).Path.TrimEnd('\').ToLowerInvariant()
  $ActualRoot = ([string]$ExistingMarket.root).TrimEnd('\').ToLowerInvariant()
  if ($ActualRoot.StartsWith('\\?\')) { $ActualRoot = $ActualRoot.Substring(4) }
  if ($ActualRoot -and $ActualRoot -ne $ExpectedRoot) {
    throw "Marketplace $MarketplaceName points to $($ExistingMarket.root), not $ExpectedRoot. Do not replace it automatically."
  }
}
~~~

按下面的规则处理：

- 市场不存在：继续添加市场。
- 市场存在且是当前本地根目录：复用它，不要重复添加。
- 市场存在但根目录指向其他项目或其他版本：不要自动删除、替换或移除它。记录市场名和根目录，报告同名市场冲突，等待用户指定是否处理。
- 目标插件已经显示 installed: true 且 enabled: true，并且来源路径与本次目标一致：安装阶段已完成，跳到验证阶段。
- 只发现 zcode-subagent@personal 或其他市场下的同名插件时，不能把它当作 zcode-subagent@slave-zcode 已安装；继续验证目标选择器。

对于 Git 市场，已有同名市场且来源明确属于该仓库时，可以先刷新快照：

~~~powershell
codex plugin marketplace upgrade $MarketplaceName
~~~

## 阶段四：注册市场并安装插件

### 本地仓库安装

当 $PluginRoot 是当前仓库根目录时，执行：

~~~powershell
if (-not $ExistingMarket) {
  codex plugin marketplace add $PluginRoot
}

if (-not $ExistingPlugin -or -not $ExistingPlugin.enabled) {
  codex plugin add $PluginSelector --json
}
~~~

### GitHub 市场安装

没有本地仓库时，执行：

~~~powershell
$RemoteMarketplace = 'https://github.com/Asuka-WILLE/Slave-Zcode.git'
$RemoteRef = 'main'

if (-not $ExistingMarket) {
  codex plugin marketplace add $RemoteMarketplace --ref $RemoteRef
}

if (-not $ExistingPlugin -or -not $ExistingPlugin.enabled) {
  codex plugin add $PluginSelector --json
}
~~~

如果远程仓库使用了其他分支，只有在用户明确指定该分支时才替换 $RemoteRef。不要通过修改插件清单、伪造市场名或直接复制缓存目录来绕过安装命令。

## 阶段五：验证安装结果

安装命令返回后重新读取状态。必须验证市场、插件、版本、启用状态和来源，而不是只看命令退出码：

~~~powershell
$InstalledState = codex plugin list --json | ConvertFrom-Json
$InstalledPlugin = @($InstalledState.installed | Where-Object { $_.pluginId -eq $PluginSelector }) | Select-Object -First 1

if (-not $InstalledPlugin) {
  throw "Installed plugin $PluginSelector was not returned by codex plugin list --json."
}
if (-not $InstalledPlugin.installed -or -not $InstalledPlugin.enabled) {
  throw "Plugin $PluginSelector is present but not installed and enabled."
}
if ([string]$InstalledPlugin.name -ne $PluginName) {
  throw "Installed plugin name mismatch: $($InstalledPlugin.name)"
}

$InstalledPlugin | ConvertTo-Json -Depth 10
~~~

从本地源码安装时，再做插件结构检查：

~~~powershell
Set-Location $PluginRoot
npm run check
~~~

如果本地源码刚刚变更过，先在不清理用户修改的前提下运行：

~~~powershell
npm ci
npm run bundle
npm run check
~~~

npm run bundle 可能更新仓库中的 bundle/server.mjs。智能体应检查 git diff，保留用户已有修改，不要未经授权提交或推送。

## 阶段六：准备 ZCode 桌面桥接

插件安装成功不代表桌面桥接已经连接。目标机器还需要 Windows、Node.js 24+ 和已配置模型通道的 ZCode 桌面；适配器会按实际调用的方法检查运行时接口，应用版本只用于诊断。

启动前先让用户正常结束 ZCode 中正在运行的任务并关闭窗口。不要杀进程，也不要在任务运行时强行重启。插件的启动脚本会自动从进程、注册表、PATH、快捷方式和常见目录发现 ZCode 安装位置：

~~~powershell
Set-Location $PluginRoot
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-zcode.ps1
npm run doctor
~~~

若是没有注册信息、没有快捷方式、也不在 PATH 中的自定义或便携版安装，才指定安装根目录：

~~~powershell
$env:ZCODE_INSTALL_DIR = 'D:\Apps\ZCode'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-zcode.ps1
npm run doctor
~~~

或者只对本次启动传入：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-zcode.ps1 -InstallDir 'D:\Apps\ZCode'
~~~

npm run doctor 和 zcode_health 合并满足下面条件，才可以报告桥接入口可用：

- installed: true
- desktop_connected: true
- zcode_health 返回 connected: true，且没有缺失接口方法
- 能够读取目标 renderer page 或本机 CDP 页面

installed: true 只证明找到了安装文件；它不证明模型已经登录、任务能够执行或项目结果正确。

## 阶段七：让新安装对 Codex 生效

插件和 MCP/Skill 通常在新建 Codex 对话时被发现。安装完成后：

1. 如果当前对话是在安装前创建的，结束当前对话或启动一个新的 Codex 对话。
2. 在新对话中确认插件已启用；CLI 可再次运行 codex plugin list --json，交互界面可使用插件列表入口检查。
3. 首次调用前执行 zcode_health，再执行 zcode_list_models，确认桌面连接和模型目录。
4. 只使用返回的真实 providerId、modelId 和推理级别，不要猜测模型名称，也不要把凭据写入请求。

如果当前智能体无法重启宿主 Codex 或创建新对话，应报告“文件安装已验证，但当前会话尚未重新加载插件”，不要声称工具已经可用。

## 常见失败处理

| 现象 | 处理方式 |
| --- | --- |
| codex 不是命令 | 运行官方 Codex CLI 安装入口，重开 PowerShell，再检查 codex --version。 |
| plugin add 不存在 | 当前 CLI 版本不支持插件子命令，升级/切换到包含 plugin marketplace、add、list 的 CLI。 |
| 找不到 zcode-subagent@slave-zcode | 先执行 codex plugin marketplace list --json，确认市场已注册且市场名与清单一致。 |
| 同名市场指向其他目录 | 停止自动修改，报告冲突根目录；不要直接删除用户市场。 |
| 插件安装后没有出现在当前对话 | 新建 Codex 对话或重载宿主，再重新检查插件列表。 |
| ZCODE_NOT_FOUND | 运行 npm run doctor；普通安装会自动发现，自定义/便携版设置 ZCODE_INSTALL_DIR 或 -InstallDir。 |
| DESKTOP_UNAVAILABLE | 确认 ZCode 已按要求正常关闭并通过 start-zcode.ps1 启动，检查 http://127.0.0.1:19222。不要杀进程。 |
| DESKTOP_INTERFACE_UNAVAILABLE | 桌面缺少适配器实际需要的服务或方法。记录错误列出的名称，确认 renderer 已完成加载，再核对协议接口。 |
| npm ci 或 npm run bundle 失败 | 保留日志和工作区修改，先报告 Node.js 版本、失败命令和首个错误；不要用清理工作区的方式“修复”。 |

## 完成报告格式

安装结束后，智能体应给出以下四类证据：

~~~text
安装结论：已注册哪个市场，安装了哪个 plugin@marketplace，是否 enabled
来源证据：manifest name/version、marketplace root/source、plugin list --json 条目
运行证据：npm run check、npm run doctor、zcode_health 的实际结果
未完成项：是否需要新建 Codex 对话、是否因 ZCode 未运行而未完成桌面集成、是否存在市场冲突
~~~

其中“插件已安装”“当前对话已加载”“ZCode 桌面已连接”“任务已经成功执行”是四个不同结论，必须分别报告。

## 官方参考

- Codex CLI：<https://learn.chatgpt.com/docs/codex/cli>
- Codex 环境变量：<https://learn.chatgpt.com/docs/config-file/environment-variables>
- 本插件仓库：<https://github.com/Asuka-WILLE/Slave-Zcode>
