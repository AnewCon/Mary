# QuantOS V1.1

私人交易监控终端。React + TypeScript + Vite；Cloudflare Pages 前端、Workers API、D1 存储、每分钟 Cron。当前交易所为 **OKX 模拟账户**，以用户最新要求为准。

## 本地运行

Node 22 或以上。`npm ci`，`npm run build`，`npm test`。

复制 `.env.example` 为 `.dev.vars`，填写管理员密码、SESSION_SECRET 和欧意三项凭证。不要上传此文件。运行 `npx wrangler d1 migrations apply quantos-db --local`，再运行 `npm run dev:api`；可直接访问 Wrangler 提供的地址。开发前端时另运行 `npm run dev`，Vite 会代理 API 到 8787。

## Cloudflare

1. `wrangler.jsonc` 的 D1 绑定指向独立 quantos-db。首次安装创建 D1 并替换 ID，再执行 `npx wrangler d1 migrations apply quantos-db --remote`。
2. 使用 `npx wrangler secret put ADMIN_PASSWORD` 等方式设置 Secrets：ADMIN_PASSWORD、SESSION_SECRET、OKX_API_KEY、OKX_SECRET_KEY、OKX_PASSPHRASE。
3. `npm run deploy` 部署 Worker。Cron `* * * * *` 在服务端每分钟拉取账户；页面每60秒读取快照，手动刷新强制调用交易所。Cron 存在平台调度延迟，界面始终显示实际成功时间，超过120秒标记过期。
4. Pages 连接 `AnewCon/Mary` 的 main 分支，构建 `npm run build`，输出 `dist`。Pages production 和 preview 配置 Service Binding `API` → `quantos`；Functions 代理 `/api/*` 到 Worker。不要将管理员或交易所密钥写入 Pages 构建变量。

## 当前边界

- 登录保护全部账户、持仓与平台管理接口；随机会话8小时，HttpOnly/Secure/SameSite cookie。
- 交易所 Secret 仅在 Cloudflare Secrets；平台 API Key 使用256位随机数、SHA-256哈希入库，只在生成时显示全文。遗失请轮换。
- **部分平仓支持欧意模拟盘市价减仓。** 滑动条选择1–100%比例，服务端以最新仓位与交易所步长重新计算张数；净持仓使用reduceOnly，双向持仓使用平多/平空组合。DEMO_TRADING_ENABLED=true 独立启用；所有请求强制模拟盘头，不支持实盘下单。
- 止盈止损订单、历史成交已实现盈亏尚未接入，显示缺失状态，不推算虚构数据。
- 钱包与保证金数据基于 OKX 的 USDT 明细；总权益为 OKX totalEq 的 USD 估值，两者币种不同。
- 停止按钮只记录 QuantOS 未来交易禁用状态，不停止其他程序。
- 普通 ChatGPT 聊天不会因为网站有 API 就自动调用。未来需要受支持连接器/MCP；当前已提供标准 Bearer API。
- 图片使用生图模型生成；同步脉冲与加载动画为网页动画，当前没有可用 GIF 生成模型。

详见 [API 文档](docs/API.md) 与 [设计留存](docs/设计说明.md)。
