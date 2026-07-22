# Model Gateway

本地 OpenAI-compatible 网关，用于统一管理多个上游 Provider，并在请求失败时按优先级自动切换。

## 功能介绍

- 提供 `/v1/chat/completions`，兼容 OpenAI Chat Completions 请求格式。
- 提供 `/v1/models`，聚合所有 Provider 的模型列表并按模型 ID 去重。
- 支持多个 Provider，每个 Provider 由 `baseUrl`、可选 `apiKey`、模型覆盖和优先级组成。
- 按优先级选择 Provider，并支持 429、5xx、网络错误和超时的 fallback。
- 按 Provider 和模型维护健康状态、失败次数、冷却时间和下一次探测时间；冷却到期后由下一次正常请求触发受锁保护的半开放探测。
- 支持管理页面：新增、编辑、删除 Provider，查看模型，手动健康探测和通信历史。
- 支持进程内 `/models` 缓存，已有缓存不会重复请求上游；重启后缓存清空，管理接口可使用 `refresh=1` 强制刷新。
- 提供下游和上游通信日志，管理页面中每条通信记录可折叠展开。
- 启动命令行显示请求路由、上游发送、上游响应和下游响应等关键节点。
- 日志和管理 API 会隐藏 API Key、Authorization 和 Cookie。
- 支持可选的网关管理 token。

网关只代理配置的 OpenAI-compatible API，不会拦截其他 HTTP/HTTPS 流量。

## 环境要求

- Node.js 22 或更高版本。
- npm。
- 可访问上游 Provider 的网络环境。

## 快速开始

### 1. 安装依赖

在 `model-gateway` 目录执行：

```powershell
npm install
```

当前项目没有运行时依赖，执行该命令主要用于保持标准 npm 工作流。

### 2. 启动服务

网关支持空配置首次启动，不需要预先创建或编辑 `model-gateway.json`：

```powershell
npm start
```

启动后打开管理页面：

```text
http://127.0.0.1:8787/
```

点击“添加 Provider”，填写 Provider 名称、Base URL、API Key、模型覆盖和优先级，保存后配置会自动写入 `model-gateway.json`。

也可以选择手动创建配置文件。此时可以复制示例配置并编辑 `model-gateway.json`：

```json
{
  "listen": "127.0.0.1:8787",
  "dataDir": "~/.local/share/model-gateway",
  "maxAttempts": 3,
  "requestTimeoutMs": 60000,
  "candidates": [
    {
      "id": "primary",
      "name": "Primary API",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "replace-with-api-key",
      "model": "optional-model-override",
      "priority": 10
    }
  ]
}
```

`model-gateway.json` 已加入 `.gitignore`，不要将包含真实密钥的配置提交到 Git。

### 3. 配置客户端

默认监听：

```text
http://127.0.0.1:8787
```

打开 `http://127.0.0.1:8787/` 可进入 Provider 管理页面。

将客户端的 OpenAI-compatible Base URL 指向：

```text
http://127.0.0.1:8787/v1
```

例如 Kilo 配置：

```jsonc
{
  "model": "local-gateway/gpt-4.1",
  "provider": {
    "local-gateway": {
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "local-gateway"
      }
    }
  }
}
```

网关下游 API Key 仅用于客户端侧配置。Provider 的真实上游 API Key 配置在网关自己的 Provider 配置中。

## 环境配置

### 配置文件路径

默认读取当前工作目录下的：

```text
model-gateway.json
```

可以使用环境变量指定其他路径：

```powershell
$env:MODEL_GATEWAY_CONFIG = "D:\config\model-gateway.json"
npm start
Remove-Item Env:MODEL_GATEWAY_CONFIG
```

### 配置字段

| 字段 | 说明 |
| --- | --- |
| `listen` | 监听地址，格式为 `host:port`。默认 `127.0.0.1:8787`。 |
| `dataDir` | 健康状态等运行时数据目录。 |
| `maxAttempts` | 单次请求最多尝试的 Provider 数量。 |
| `requestTimeoutMs` | 单次网关请求的总超时时间。 |
| `token` | 可选。设置后保护 `/admin/*` 和下游 `/v1/*` 接口。 |
| `activeWindowMs` | 健康活动窗口。 |
| `queueTimeoutMs` | 请求排队超时时间。 |
| `healthStateMaxAgeMs` | 健康状态最大保存时间。 |
| `health` | 健康降级、冷却和退避参数。 |
| `candidates` | Provider 配置数组。 |

Provider 字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 必填且唯一，用于编辑、删除和健康状态关联。 |
| `name` | 可选的显示名称。未设置时显示 `id`。 |
| `baseUrl` | 必填，只接受 HTTP/HTTPS。通常填写带 `/v1` 的 API 根地址。 |
| `apiKey` | 可选。支持无认证的本地上游 API。 |
| `model` | 可选的模型覆盖。为空时透传客户端模型。 |
| `priority` | 可选，数字越小优先级越高，默认 `100`。 |

不要使用旧的 `service`、`account` 或 credential 配置字段。当前网关只使用统一 Provider 配置。

### 管理 token

配置：

```json
{
  "token": "replace-with-gateway-token"
}
```

请求管理接口时携带：

```powershell
Invoke-WebRequest `
  -Uri "http://127.0.0.1:8787/admin/providers" `
  -Headers @{ Authorization = "Bearer replace-with-gateway-token" }
```

## 常用接口

### 下游接口

```text
GET  /v1/models
POST /v1/chat/completions
```

`GET /v1/models` 会使用每个 Provider 的进程内模型缓存；无缓存时查询上游 `/models`，然后合并并去重。网关重启后缓存会清空。Provider 管理接口使用 `?refresh=1` 时会强制重新查询对应上游。

Provider 进入冷却后，冷却期间的正常请求会跳过该 Provider；`nextProbeAt` 到达后，下一次正常请求允许一个半开放尝试。并发请求不会重复探测同一个 Provider：成功后恢复 `healthy`，失败后重新进入退避冷却。也可以通过管理页面手动点击“探测”立即执行探测。

### 管理接口

```text
GET    /admin/providers
POST   /admin/providers
PUT    /admin/providers/:id
DELETE /admin/providers/:id
GET    /admin/providers/:id/models
GET    /admin/providers/:id/history
POST   /admin/providers/:id/probe
GET    /admin/logs
GET    /admin/health
POST   /admin/health/reset
```

Provider 模型查询默认使用缓存，强制刷新：

```text
GET /admin/providers/:id/models?refresh=1
```

## 运行与调试

## Windows 单文件 EXE

如果目标电脑不能安装 Node.js 或 npm，可以在一台有 Node.js 22 和 npm 的 Windows x64 构建机上生成单文件版本。目标电脑不需要安装 Node.js、npm、Python 或 pip。

在源码目录执行：

```powershell
npm install
npm run build:win
```

构建结果为 `dist/model-gateway.exe` 和可选的 `dist/model-gateway-tray.exe`。将网关 EXE 复制到目标电脑后可以直接双击启动。双击时程序默认执行 `start`，启动后打开 `http://127.0.0.1:8787/`。也可以在命令行中显式运行：

```powershell
 .\model-gateway.exe start
```

首次启动可以不提供配置文件，然后打开 `http://127.0.0.1:8787/` 添加 Provider。对于 EXE，默认会从 EXE 所在目录读取 `model-gateway.json`，并将运行数据固定写入 EXE 旁的 `data` 目录，不依赖 Windows 用户名。配置文件不会嵌入 EXE，升级 EXE 时保留该文件和 `data` 目录即可保留配置与运行状态。便携发布不需要填写 `dataDir`。

如果配置中使用相对路径，例如 `"dataDir": "data"`，EXE 模式下路径相对于 EXE 所在目录；也可以填写绝对路径。源码开发运行时相对路径仍相对于当前工作目录。

如果配置文件位于其他位置：

```powershell
$env:MODEL_GATEWAY_CONFIG = "D:\config\model-gateway.json"
.\model-gateway.exe start
Remove-Item Env:MODEL_GATEWAY_CONFIG
```

`build:win` 当前只生成 Windows x64 产物。构建脚本会先将本地源码 bundle，再使用 Node Single Executable Application 注入运行时；发布目录中的 `model-gateway.json`、密钥和 `dataDir` 内容不会被打包。EXE 仍需能够访问已配置的上游 Provider 网络地址。

可选托盘 EXE 由独立的 self-contained .NET WinForms GUI helper 构建，不依赖 PowerShell 或目标机上的 .NET。托盘和 EXE 使用 `native/TrayHelper/assets/tray.ico` 中的多尺寸图标资源。它会启动同目录下的 `model-gateway.exe`，等待 `/health` 成功后自动打开管理页面，并提供打开页面、查看状态、打开 `data/logs` 和退出菜单。托盘菜单退出会先通过仅限本机的随机控制令牌请求网关有序停止，再退出托盘；直接启动网关不依赖托盘。`build:win` 会验证网关 PE 子系统为 Console、托盘 PE 子系统为 Windows GUI。托盘诊断日志位于 `data/tray-debug.log`，不记录 API Key 或控制令牌。

托盘诊断日志还会记录托盘自身 PID、托盘启动的网关 PID，以及启动前后监听端口对应的占用 PID。托盘通过受控制令牌保护的 `/__control/health` 确认连接的是自己启动的网关；如果端口已被其他网关实例占用，不会误接管该实例。图标由项目内的 `uv` 虚拟环境和 Pillow 从原始 PNG 转换为多尺寸 ICO；虚拟环境位于 `.venv`，不参与发布构建。

启动时命令行会打印关键通信节点，例如：

```text
[gateway] DOWNSTREAM SEND POST /v1/chat/completions
[gateway] ROUTE selected=Primary API attempts=1
[gateway] UPSTREAM SEND provider=Primary API model=gpt-4.1 POST https://api.example.com/v1/chat/completions
[gateway] UPSTREAM RECV provider=Primary API model=gpt-4.1 status=200 duration=245ms
[gateway] DOWNSTREAM RECV status=200
```

命令行只打印摘要，不打印请求 body、API Key 或完整响应内容。

运行测试：

```powershell
npm test
```

检查源码语法：

```powershell
npm run check
```

## 安全注意事项

- 不要提交 `model-gateway.json`。
- 不要在 `config.example.json` 或 README 中写入真实 API Key。
- 不要将 `dataDir` 下的运行时状态文件提交到仓库。
- 管理页面和 `/admin/*` 接口建议只绑定本机，或配置 `token` 后再暴露到其他网络。
- Provider API Key 只保存在本地配置中，命令行和管理 API 会脱敏处理。
