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
| /api/trades/:id/close | POST | 登录会话 | `{"confirm":true,"requestId":"UUID"}`，重新同步真实持仓后生成模拟审计 |
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

模拟平仓状态 SIMULATED 不代表交易所实际成交。没有实盘订单接口。仅会话用户可操作模拟平仓和停止状态，read/write无法调用。
