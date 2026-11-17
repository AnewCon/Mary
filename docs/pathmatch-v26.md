# PathMatch V2.6 影子观察

桌面入口为「预测交易」，手机端可从账户页进入。欧易收益账本、当前持仓在欧易账户内切换。

D1 迁移 `0010_pathmatch.sql` 保存不可覆盖的草稿、锁定时间、ATR、状态和已观测 K 线。Worker 每分钟查看活动记录，每个币种合并请求；VPS 仅访问 Binance Demo 的公开 K 线和时钟接口。最多 5 个活动计划。锁定以后的第一根完整 1m 开始计时，采用 D1 版本条件防止重试覆盖已更新状态。

## MCP

1. `quantos_prediction_reference` 用 `{"symbol":"BTCUSDT"}` 获取最新已收盘锚点和 suggestedStartAt。
2. `quantos_prediction_create` 传 32 位小写十六进制 id 和下面的 plan。一份计划只能复用同编号和相同内容。
3. `quantos_prediction_arm` 传 `{"id":"...","mode":"SHADOW","confirm":true}`。若跨分钟导致锚点变化，创建新版本再授权。
4. `quantos_prediction_status` 查询 id，`quantos_prediction_history` 可按币种、版本、状态、起止时间过滤，`quantos_prediction_cancel` 传 id 和 confirm 停止观察并保留记录。

结构示例（时间、价格需由调用者替换为实际值）：

```json
{
  "strategyVersion":"2.6-pathmatch","symbol":"BTCUSDT","exchange":"BINANCE_DEMO","direction":"LONG",
  "referenceTime":1800000000000,"referencePrice":100,"expiresAt":1800000960000,"source":"Binance Demo 已收盘参考",
  "forecast":{"interval":"1m","candles":[
    {"time":1800000060000,"open":100.0,"high":100.15,"low":99.89,"close":100.06},
    {"time":1800000120000,"open":100.06,"high":100.21,"low":99.95,"close":100.12},
    {"time":1800000180000,"open":100.12,"high":100.27,"low":100.01,"close":100.18},
    {"time":1800000240000,"open":100.18,"high":100.33,"low":100.07,"close":100.24},
    {"time":1800000300000,"open":100.24,"high":100.39,"low":100.13,"close":100.3},
    {"time":1800000360000,"open":100.3,"high":100.45,"low":100.19,"close":100.36},
    {"time":1800000420000,"open":100.36,"high":100.51,"low":100.25,"close":100.42},
    {"time":1800000480000,"open":100.42,"high":100.57,"low":100.31,"close":100.48},
    {"time":1800000540000,"open":100.48,"high":100.63,"low":100.37,"close":100.54},
    {"time":1800000600000,"open":100.54,"high":100.69,"low":100.43,"close":100.6},
    {"time":1800000660000,"open":100.6,"high":100.75,"low":100.49,"close":100.66},
    {"time":1800000720000,"open":100.66,"high":100.81,"low":100.55,"close":100.72},
    {"time":1800000780000,"open":100.72,"high":100.87,"low":100.61,"close":100.78},
    {"time":1800000840000,"open":100.78,"high":100.93,"low":100.67,"close":100.84},
    {"time":1800000900000,"open":100.84,"high":100.99,"low":100.73,"close":100.9}
  ]},
  "entry":{"type":"LIMIT","price":100,"priceMin":99,"priceMax":101},"hardInvalidation":96,
  "risk":{"leverage":10,"quantity":0.01,"stopLoss":97,"takeProfit":107,"maxLossUsdt":0.35,
          "estimatedLossCostsUsdt":0.01,"estimatedWinCostsUsdt":0.01},
  "context":{"trend4h":"LONG","trend1h":"LONG","structure15m":"未核验","entry5m":"未核验",
             "dailyFilter":"未核验","directionScore":80,"entryScore":80},
  "validation":{"similarityThreshold":85,"minimumClosed1mCandles":3,"maximumValidationMinutes":15,"atrTolerance":0.5}
}
```

新预测必须提供连续 15 根独立的 1 分钟 OHLC，首根以 suggestedStartAt 起算。Chat 与网站绘制同一份冻结预测；K 线用开收价画红绿实体，高低价画上下影线。旧三根 5m 记录会保留，开盘价以参考价或上一根预测的收盘价绘制。新计划使用真实 OHLC 比较。

每分钟同步已收盘的实际 K 线，与预测按 UTC 分钟对齐。轨迹相似度为 100×max(0,1−收盘价 RMSE/(2×锁定 ATR))；区间重合度为每分钟高低价区间交集除以并集，再取平均；趋势一致度为收盘变化方向匹配比例，中性容差为 ATR×0.02。三项权重为 40% / 35% / 25%。拟合百分比只用于影子复核。

满 15 根连续收盘 K 线才有最终结果；判为 REVIEW 仍须独立核对交易规则和实际账户。触发硬性失效仍保存后续走势用于复盘，并保留 WAIT。最后一根若延迟，最多额外等待约 75 秒，并且只记录预测窗口内的 K 线。

## 上线范围与回滚

本版为 SHADOW。符合路径的计划提示独立执行风控待复核。DEMO_AUTO、历史重放与阈值样本外对照尚待验收，现有 Binance Demo 订单生命周期未改动。100 个独立样本需要随时间采集。

先执行 D1 迁移，再更新 VPS 行情中继、Worker、MCP 和 Pages。回滚 Worker 后预测自然观测暂停，D1 保留所有记录；VPS 可恢复 `relay.py.before-pathmatch` 并重启行情服务。旧版模拟订单由原服务继续管理。

管理员可在预测详情删除记录。迁移 `0011_pathmatch_deleted_at.sql` 新增删除时间，列表与状态查询隐藏已删除记录，正在观测的记录停止更新，预测原文及已有结果继续保存在 D1。
