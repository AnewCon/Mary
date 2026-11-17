# QuantOS 策略中心 V1.0

策略版本使用项目内的 SemVer 标识，配置采用 JSON Schema 1，应用部署标识是 strategy-center-v1.0。示例为依据可查资料写成的待审核示例。旧版本原文和未归因的既有订单保持原样。

## 管理与读取

在网站登录管理员后，进入「交易策略」。可新建、导入 JSON 或 Markdown、检查结构、保存草稿、校验、发布、启用，以及回滚到曾启用的版本。导入 JSON 支持 `{name,document,config}` 或单独的配置。Markdown 保留原文，无法识别的参数由用户补齐，预检标 `UNKNOWN`。可用例见 `strategies/strategy-center.example.json`。发布、启用和回滚各自要求确认。已发布内容通过服务端和数据库双重保护。

管理使用同源会话 POST `/api/strategies/{preview,create,edit,validate,publish,activate,rollback}`。启用与回滚需提供 `confirm:true` 和刚读取的 `generation`。首次启用用 0。编辑、校验、发布需当前 `revision`。并发切换只有一个获胜，切换同时写入审计。

MCP 只读工具如下。成功响应的 `structuredContent.data` 承载结果，失败响应有 `isError:true` 和服务器错误码。

| MCP | 参数 |
| --- | --- |
| `quantos_strategy_active` | `{environment:"BINANCE_DEMO_FUTURES"}`，环境可省略 |
| `quantos_strategy_list` | `strategyId, name, state, version, from, to, limit` 均可选 |
| `quantos_strategy_get` | `{strategyId:"quantos-intraday",version:"2.6.0-review.1"}` |
| `quantos_strategy_history` | `strategyId` 必填，`version, limit` 可选 |
| `quantos_strategy_compare` | `strategyId, fromVersion, toVersion` |
| `quantos_strategy_performance` | `strategyId, version` 必填，`from, to` 可选，UTC 毫秒 |

`active` 返回 `strategyId, version, generation, document, config, contentHash, publishedAt, activatedAt, executionAuthorized, capabilities, safetyLimits` 等。内容哈希是按名称、原文、结构化配置构造对象后递归排序键并编码为 UTF-8 的 SHA-256。主要错误码为 `STRATEGY_NO_ACTIVE`、`STRATEGY_INTEGRITY_ERROR`、`STRATEGY_CHANGED_OR_UNBOUND`、`STRATEGY_ACTIVE_CHANGED`、`STRATEGY_VERSION_CONFLICT`、`STRATEGY_REVISION_OR_STATE_CONFLICT` 和 `STRATEGY_EXECUTION_NOT_ACCEPTED`。

## PathMatch 和交易边界

创建新预测时提交 `strategy:{strategyId,version,contentHash,generation}`，从 `active` 获取。数据库在写入时再次对照 ACTIVE，并将预测和对应不可变策略在同一批次记录。现有预测仍可查询，早期未绑定记录无版本归因。已绑定预测继续使用创建时的参数，PathMatch 仅支持 SHADOW。

自动及 MCP 新开仓当前要求策略存在并核对版本，随后返回待执行验收。独立的行情新鲜度、组合敞口、交易所保护验证及成交账单归因尚未串成可信执行链。现有管理员网页手工交易路径和持仓管理保留。绩效提供按版本和时间查询的影子样本及拟合分布，成交绩效与回测暂显示样本不足。近 30 天为默认窗口，单次最多读取 500 条影子样本。

## 部署与回滚

1. 确认 D1 已执行 PathMatch 的 0010 和 0011，再执行 `0012_strategy_center.sql`。
2. 发布 QuantOS API Worker，再发布 QuantOS MCP Worker。推送主分支后等待 Cloudflare Pages 构建。此更新使用原 VPS 交易和行情服务。
3. 验证管理会话权限、只读 MCP、没有 ACTIVE 时的错误，以及影子预测行为。导入经审核的策略后，由管理员独立发布和启用，再在新 Chat 中调用 `quantos_strategy_active`。
4. 如需回滚前端及 API，恢复上一版本 Pages 和 Workers。数据库迁移是增量，保留策略与版本链接。回滚旧 Workers 可能恢复原 MCP 新开仓入口，回滚前应单独控制币安模拟交易权限。
