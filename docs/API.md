# QuantOS API v1

部署站点同源 `/api`。只使用 HTTPS。程序请求头 `Authorization: Bearer <平台密钥>`；不要把密钥放 URL。平台密钥不同于欧意密钥。

成功：`{"ok":true,"data":{}}`；错误：`{"ok":false,"error":{"code":"UNAUTHORIZED"}}`。

| 路径 | 方法 | 权限 | 数据 |
|---|---|---|---|
| /api/account | GET | read | 账户快照、原始持仓、updatedAt；无同步返回 null |
| /api/positions | GET | read | OKX 原始持仓数组 |
| /api/status | GET | read | exchange,mode,interval,configured,updatedAt,stale,error,halt |
| /api/sync | POST | write | `{}`；主动读取交易所并返回新快照 |
| /api/ai/decisions | GET | read | 最近100条分析 |
| /api/ai/decisions | POST | write | content 必填；symbol,direction,recommendation,source 可选 |
| /api/ai/logs | GET | read | 最近100条日志 |
| /api/ai/logs | POST | write | 同分析输入结构 |
| /api/login | POST | 公开限流 | `{"password":"..."}`，签发会话 |
| /api/logout | POST | 登录会话 | 撤销当前会话 |
| /api/keys | GET | 登录会话 | 只返回掩码、元数据 |
| /api/keys | POST | 登录会话 | `{"name":"GPT","scopes":["read","write"]}`，返回一次性完整 key |
| /api/keys/:id/revoke | POST | 登录会话 | 撤销密钥；轮换为先创建后撤销 |
| /api/trades/:id/close | POST | 登录会话 | `{"confirm":true,"requestId":"UUID","percent":25,"expectedPos":"10","expectedQuantity":"2.5","expectedInstId":"BTC-USDT-SWAP","expectedPosSide":"net"}`，欧意模拟盘市价减仓，详见下方 V1.1 接口 |
| /api/system/halt | POST | 登录会话 | `{}`，记录停止未来指令 |

写入示例：

```js
await fetch('https://YOUR_SITE/api/ai/decisions', {
  method: 'POST',
  headers: {'Authorization': 'Bearer '+platformKey, 'Content-Type': 'application/json'},
  body: JSON.stringify({symbol:'BTC-USDT-SWAP',direction:'观察',content:'你的分析',recommendation:'你的建议',source:'authorized-client'})
});
```

返回 `{"ok":true,"data":{"id":"UUID"}}`。记录包含 created_at 与 JSON 字符串 data。

请求体最多16KiB；content 1–8000字符；可选文本字段最多200字符。密钥名1–60字符；trade权限不允许签发。平台密钥每分钟最多60次请求；手动同步全局每分钟最多4次；登录每IP每分钟5次。

错误：400 INVALID_JSON / INVALID_KEY_INPUT / INVALID_RECORD / CONFIRMATION_REQUIRED；401 UNAUTHORIZED / INVALID_LOGIN；403 ORIGIN_DENIED；404 NOT_FOUND / POSITION_NOT_FOUND；409 SYNC_IN_PROGRESS / DUPLICATE_REQUEST；413 REQUEST_TOO_LARGE；429 RATE_LIMITED；503 ADMIN_NOT_CONFIGURED / OKX_CREDENTIALS_INCOMPLETE / SYNC_NETWORK_FAILURE；交易所失败只返回脱敏 OKX_ERROR_数字 或 OKX_HTTP_状态码。

仅会话用户可操作模拟盘平仓和停止状态，read/write无法调用。旧版SIMULATED记录只代表旧模拟审计，新版返回交易所订单状态。没有实盘交易接口。

## V1.1 部分平仓

- GET /api/trades/:positionId/close-quote：登录会话；返回交易所新鲜持仓、lotSz、minSz、maxMktSz、合约面值、模式及enabled。不下单。
- POST /api/trades/:positionId/close：登录会话；使用表中的确认请求。比例为1–100整数。数量单位是合约张数，并按lotSz向下取整。服务端核对expectedPos、expectedQuantity、expectedInstId、expectedPosSide；不信任前端数量。
- GET /api/trades/actions：登录会话；最近30次操作，状态及实际成交量。
- POST /api/trades/actions/:requestId/reconcile：登录会话；查询原clOrdId订单并重新同步持仓，绝不重新下单。

状态：SUBMITTING/PENDING/LIVE/PARTIALLY_FILLED/UNKNOWN 尚未终结；FILLED/CANCELED/MMP_CANCELED/REJECTED 为终态。filledQuantity为交易所累计成交张数，remainingPosition为随后账户查询结果；syncError非空时剩余仓位可能尚未更新。

同一requestId只能提交一次，重复请求查询原订单；同一持仓最多一个待确认操作。订单超时后先查订单，查不到仍保持UNKNOWN，不自动重发。已有其他委托占用仓位时不擅自撤单。

DEMO_TRADING_ENABLED=true 才可下单。仅支持SWAP、cross/isolated、净持仓/双向持仓，以及欧意账户等级2/3。其他账户模式安全拒绝。所有请求强制x-simulated-trading:1。净持仓必须reduceOnly；双向持仓平多sell+long、平空buy+short。

新增错误：INVALID_CLOSE_REQUEST、DEMO_TRADING_DISABLED、POSITION_CHANGED、QUANTITY_CHANGED、BELOW_MINIMUM_SIZE、INSUFFICIENT_CLOSEABLE_SIZE、UNSUPPORTED_ACCOUNT_MODE、UNSUPPORTED_POSITION_MODE、MARKET_SIZE_EXCEEDED、CLOSE_IN_PROGRESS、IDEMPOTENCY_CONFLICT。错误/待确认操作必须先查看记录，不得以新requestId盲目重试。
