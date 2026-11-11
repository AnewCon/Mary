# QuantOS 币安模拟盘本机 MCP

本机服务通过指定的 Windows 本地 HTTP 代理连接 `demo-fapi.binance.com`。它支持查看账户和仓位、查询订单结果、市价开仓、按比例市价平仓和调整杠杆。订单请求编号保存在本机 `.wrangler/binance-mcp`，交易所响应不明时用原编号查询。

## 本机启动

使用 Node.js 24，并在 QuantOS 项目目录执行 `npm ci`。通过启动进程的环境变量提供以下值。

| 环境变量 | 用途 |
| --- | --- |
| `BINANCE_DEMO_API_KEY` | 币安模拟盘 HMAC API Key |
| `BINANCE_DEMO_SECRET_KEY` | 对应的 Secret Key |
| `BINANCE_DEMO_PROXY` | 本地 HTTP 代理地址，例如 `http://127.0.0.1:10809` |
| `BINANCE_DEMO_TRADING_ENABLED` | 默认 `false`，完成账户读取验收后可设为 `true` |

也可在项目目录使用已被 Git 忽略的 `.env.binance-mcp` 本地配置文件。运行命令为 `node scripts/binance-mcp-local.mjs`。服务通过标准输入输出收发 MCP 消息。

## 接入 ChatGPT

1. 在有权限的 OpenAI Platform 项目创建 Secure MCP Tunnel，并关联要使用的 ChatGPT 工作区。
2. 在运行 QuantOS 的电脑上配置 `tunnel-client`，选择 stdio，启动命令填 `node`，参数填 `scripts/binance-mcp-local.mjs` 的绝对路径。把运行密钥填入客户端的本地安全配置。
3. 运行 `tunnel-client doctor --profile <名称> --explain`，确认客户端可连接。
4. 在 ChatGPT 网页端打开 Plugins → Add custom MCP server → Connection → Tunnel，选择对应隧道。首次测试调用 `binance_demo_get_account`。

本机代理若返回 HTTP 451 并提示地区受限，请在币安确认当前网络的服务可用性。ChatGPT 到 MCP 的隧道只负责转发工具调用，MCP 到币安的请求仍由本机发出。电脑、MCP 隧道客户端和本地代理需保持运行。

[OpenAI 安全 MCP 隧道文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
