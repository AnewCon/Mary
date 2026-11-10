# QuantOS MCP 接入与手机验收

## 当前架构

QuantOS 网站与 API 仍运行在原有 Cloudflare Pages、Worker 与 D1。新增独立 `quantos-mcp` Worker，通过 Cloudflare Service Binding 调用原 API。正式 MCP 地址：

`https://marya-4j3.pages.dev/mcp`

该地址使用 QuantOS 平台 Bearer 密钥鉴权；不是欧意 API 密钥，也不接受管理员登录密码。服务没有交易工具。

ChatGPT 接入使用一个独立、仅拥有者可访问的 Sites 连接桥。Sites 负责 ChatGPT 登录与 Site 访问控制；连接桥在服务端使用独立 read/write 平台密钥调用 Cloudflare MCP。完整密钥只保存在本地忽略配置和 Sites Secret，不写入 GitHub、网页或手机聊天。

## 提供的工具

| 工具 | 行为 |
|---|---|
| quantos_get_account | 读取模拟账户快照 |
| quantos_get_positions | 读取持仓，并返回实际同步时间及过期标志 |
| quantos_get_status | 读取同步、连接和模拟盘状态 |
| quantos_get_performance | 读取累计收益及北京时间今日收益 |
| quantos_list_plans | 读取最近100条交易计划 |
| quantos_write_plan | 保存观察/做多/做空计划，不下单 |

MCP 支持无状态 JSON-RPC over HTTP，包括 `server/discover`、`initialize`、`tools/list`、`tools/call`、`ping` 与通知。GET /mcp 返回405，不维护长连接，适合 Workers 免费额度。每次调用沿用平台密钥限流与权限校验。撤销专用密钥后，MCP 立即失去读取和写入权限。

## 交易计划 API

- GET /api/ai/plans：read权限；返回最近100条计划。
- POST /api/ai/plans：write权限；每个调用主体每分钟最多20次。
- 必填：requestId（UUID）、symbol、direction（long/short/observe）、content。
- 可选：entry、stopLoss、takeProfit（正十进制字符串）、expiresAt（时间字符串）。
- 重试使用同一个 requestId；同一请求不会重复写入；相同ID配不同内容会返回冲突。
- 返回记录强制 `status=plan_only`、`execution=false`。价格只是计划文字，不会创建保护订单。

网站 → AI手记 → 来自对话的交易计划，可核对实际写入结果。

## 已完成验证

35项本地测试通过，覆盖账户原有功能、MCP发现、鉴权、只读密钥禁止写入、计划幂等、密钥撤销，以及模拟移动浏览器请求格式。线上独立MCP已实际读取持仓，写入并重新读回一条 `SYSTEM-CHECK` 连接测试计划；没有向交易所发送订单。

模拟 iPhone/Android User-Agent 只验证服务端协议兼容，**不等于手机 ChatGPT 已验收通过**。

## 手机实际验收

1. 使用与当前相同的 ChatGPT 账号，安装并连接 QuantOS 私人交易计划连接器。若平台尚未完成安装或连接，先完成该步骤。
2. 手机上新建对话，选择 QuantOS 插件，发送：“读取 QuantOS 当前仓位，告诉我同步时间与数据是否过期。”
3. 再发送：“把一条 SYSTEM-CHECK 观察计划保存到 QuantOS，内容为‘手机连接测试，不执行交易’。” 写入前按 ChatGPT 提示确认。
4. 打开网站 AI手记，核对新增计划的内容与时间；再让 ChatGPT 读取交易计划，核对是同一条记录。
5. 只有两次实际调用均成功，并能在网站核对写入结果，才记为手机验收通过。若没有插件选择入口、工具未加载或访问被拒绝，记录手机系统、App版本和具体错误，继续处理。

## 维护

Cloudflare 独立服务配置在 wrangler.mcp.jsonc；新增数据库迁移为 migrations/0004_plans.sql。Sites 连接桥源码在 integrations/chatgpt-bridge，Site身份保存在该目录的 .openai/hosting.json。保持连接桥仅拥有者可访问。更换平台密钥后，同时更新 Sites Secret 并重新部署。

官方说明：

- https://learn.chatgpt.com/docs/extend/mcp
- https://learn.chatgpt.com/docs/plugins
- https://developers.openai.com/plugins/build/plugins

远程MCP服务可访问只是前提，插件是否已在当前账户安装、是否适用于手机端，仍应分别确认。

## 已发布入口

Sites 私有连接器：https://quantos-snow-mcp-20261110.evenbroth3.chatgpt.site

Sites 已确认 MCP 就绪、环境变量版本1已生效，访问策略为 custom 且只有拥有者1人。对应插件已生成，可通过平台安装入口安装/连接。此时 Cloudflare 独立服务与 Sites 发布均已完成，手机真实 ChatGPT 调用仍待用户完成安装后验收。

平台安装状态：发布后平台返回 Already installed，确认插件已安装；本聊天尚未加载该插件工具，因此不能把安装状态等同于当前聊天已连接验证。建议手机同账号新建聊天选择插件。

本机直接验证私有 Sites 地址时收到平台403，尚未完成这条本机到私有Site的服务访问探测；没有放宽站点访问权限。Cloudflare独立MCP的线上读仓与写计划测试已成功，Sites平台报告发布成功并已启用MCP。手机实际调用仍为待验收。
