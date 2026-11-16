# QuantOS V2.5

## 部署和配置

1. 应用 D1 迁移 `migrations/0009_oi_snapshots.sql`。`oi_snapshots` 使用 (exchange, symbol, source_timestamp) 和采集时隙双重唯一约束，按来源时间建立清理索引。数值以原始十进制字符串保存，毫秒时间戳以 UTC 为准。
2. 部署 QuantOS Worker 和 MCP Worker，然后发布 Pages 和现有的私有 ChatGPT 连接器。VPS 复用已有的出站行情桥，不开放新端口。
3. 把 `scripts/oi_collector.py` 和 `scripts/market-reference-relay.py` 安装到 `/opt/quantos-market-relay/`，后者命名为 `relay.py`，更新并重启 `quantos-market-relay.service`。用该服务的日志检查写入结果。
4. 更新 `/opt/quantos-binance/` 的 `push.py` 与 `binance_limit_lifecycle.py`。现有队列和持久状态文件继续使用。已验收的模拟服务以 `QUANTOS_DEMO_LIMIT_ENABLED=true` 开启需要逐单确认的组合单。回滚时可把该服务环境变量改为 `false` 并重启，已有单仍由生命周期管理器跟踪。

VPS 可在 `/etc/quantos-market-relay/config.env` 设置：

```ini
QUANTOS_OI_SYMBOLS=BTC,ETH,SOL,ZEC,NEAR
QUANTOS_OI_INTERVAL_MINUTES=15
QUANTOS_MARKET_DAILY_REQUESTS=3500
```

同步设置 Worker 的 `OI_INTERVAL_MINUTES`。`OI_RETENTION_DAYS` 默认 90，UTC 03:17 由已有 Cron 清理过期行。市场缓存默认热力图 120 秒、爆仓 20 秒、其余 60 秒，可以用 Worker 的 `MARKET_CACHE_TTL` JSON 按 `heatmap`、`liquidations`、`derivatives`、`overview` 覆盖。策略阈值和权重可用 `MARKET_SIGNAL_CONFIG` 覆盖，例如：

```json
{"weights":[40,20,15,10,15],"minEntry":60,"shortSpikePct":3,"maxRangePct":5,"minTurnover":5000000}
```

VPS 请求预算按 UTC 日计数，当前计数保存在进程中，重启后重新累计。VPS 日志聚合提供方请求量、错误量、请求路径与响应字节、D1 插入数；Worker 的 `market_cache` 日志记录命中、未命中、错误、摘要字节和耗时，未记录完整行情。

## MCP 示例

```json
{"symbol":"BTC","include":["derivatives","oi_history","liquidation_heatmap","recent_liquidations"]}
```

响应包含 `observed`、`estimated`、`derived` 与 `interpretation`。下面是缺少足够历史数据时的缩略示例：

```json
{"symbol":"BTCUSDT","status":"PARTIAL","derived":{"oiHistory":{"data":{"changes":{"24h":{"status":"INSUFFICIENT_DATA","reason":"MISSING_BASELINE"}}}}},"interpretation":{"strategyVersion":"2.5-experimental","recommendation":"WAIT","entryScore":null}}
```

若要评分，Chat 可传同币种 15m、1h、4h 的各 8–24 根已收盘 K 线，以及近期主动买入成交占比 `flow: {ratio,asOf,source}`。K 线每项为 `{time,open,high,low,close,volume}`，时间为开盘 UTC 毫秒。网页按需读取并展示 WAIT 原因，K 线与主动成交由 Chat 提供。V2.5 评分和执行彼此独立。

## Binance Demo 验收与保护

- 模拟组合单支持同一已确认请求指定 `leverage:10`。VPS 设置并回读后再入场，失败时不提交委托。
- Demo ETHUSDT 委托 16872539035 成交并确认两张保护单都为 NEW。测试仓位与残留单已清理。恢复测试前杠杆时交易所返回 -4028，ETHUSDT 模拟配置仍为 10 倍。
- Demo 委托 16872540324 验证到期自动撤销，交易所复查为 CANCELED、成交量为零。只在隔离进程推进到期判断时钟，生产时长为 45 分钟。
- 9 项模拟响应回归覆盖部分成交、撤单竞态、断网恢复、重启续管和保护清理；这些竞态未在 Demo 撮合环境中人为复现。入场到两张保护单确认之间存在风险窗口。保护失败时取消余量、暂停新开仓并报告实际持仓，后续继续核查。没有配置自动市价平仓作为应急动作。未调用实盘下单接口。

## VPS 实测与月度估算

每项为一次样本。请求字节是 URL 路径及查询串，响应字节是不含 HTTP/TLS 开销的有效载荷。

| 接口 | 请求字节 | 响应字节 |
|---|---:|---:|
| Bybit 单合约 ticker（5 币种实测范围） | 49–50 | 855–876 |
| Bybit BTC 账户多空比 | 73 | 228 |
| Blockmetric BTC 24h 热力图 | 30 | 70,545 |
| MarginPad BTC 12 条样本 | 45 | 1,696 |
| CoinGecko 前 20 币种 | 87 | 15,818 |
| Bybit 历史 OI 评估查询（10 条） | 83 | 1,133 |

历史接口没有同时给出标记价和 OI 名义价值。本版本只保存明确来源时点的 ticker 快照，未回填历史。默认每天 480 个 ticker 请求、96 次批量上传、480 条新增 OI 逻辑记录。30 天共 14,400 个请求、2,880 次上传、14,400 条新增记录、约 15.6 MB 有效载荷。90 天稳定规模约 43,200 条快照，达到保留期后再新增与删除，索引也会产生写入。

BTC 组合分析一次冷调用约 73.3 KB 提供方响应，线上 MCP 结构化结果样本 7,827 字节。若每天有 30 次冷查询，30 天约额外 3,600 次提供方请求、66.2 MB 原始响应。实际取决于币种、数据量、缓存和重试。现有出站连线空闲时约每 18 秒长轮询一次，约 4,800 次/天，不查询行情。VPS 是现有实例，新增 OI 的 D1 数据量低于官方免费额度；是否有其他增量费用取决于账号整体用量及 VPS 套餐。
