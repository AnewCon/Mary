# PathMatch V2.6 影子观察

桌面入口为「预测交易」，手机端可从账户页进入。欧易收益账本、当前持仓在欧易账户内切换。

D1 迁移 `0010_pathmatch.sql` 保存不可覆盖的草稿、锁定时间、ATR、状态和已观测 K 线。Worker 每分钟查看活动记录，每个币种合并请求；VPS 仅访问 Binance Demo 的公开 K 线和时钟接口。最多 5 个活动计划。锁定以后的第一根完整 1m 开始计时，采用 D1 版本条件防止重试覆盖已更新状态。

## MCP

1. `quantos_prediction_reference` 用 `{"symbol":"BTCUSDT"}` 获取最新已收盘锚点。
2. `quantos_prediction_create` 传 32 位小写十六进制 id 和下面的 plan。一份计划只能复用同编号和相同内容。
3. `quantos_prediction_arm` 传 `{"id":"...","mode":"SHADOW","confirm":true}`。若跨分钟导致锚点变化，创建新版本再授权。
4. `quantos_prediction_status` 查询 id，`quantos_prediction_history` 可按币种、版本、状态、起止时间过滤，`quantos_prediction_cancel` 传 id 和 confirm 停止观察并保留记录。

结构示例（时间、价格需由调用者替换为实际值）：

```json
{
  "strategyVersion":"2.6-pathmatch","symbol":"BTCUSDT","exchange":"BINANCE_DEMO","direction":"LONG",
  "referenceTime":1800000000000,"referencePrice":100,"expiresAt":1800000540000,"source":"Binance Demo 已收盘参考",
  "forecast":{"interval":"5m","candles":[
    {"direction":"UP","close":101,"high":102,"low":99,"invalidatesWhen":"跌破硬性失效价"},
    {"direction":"UP","close":102,"high":103,"low":100,"invalidatesWhen":"跌破硬性失效价"},
    {"direction":"FLAT","close":102,"high":104,"low":101,"invalidatesWhen":"跌破硬性失效价"}
  ]},
  "entry":{"type":"LIMIT","price":100,"priceMin":99,"priceMax":101},"hardInvalidation":96,
  "risk":{"leverage":10,"quantity":0.01,"stopLoss":97,"takeProfit":107,"maxLossUsdt":0.35,
          "estimatedLossCostsUsdt":0.01,"estimatedWinCostsUsdt":0.01},
  "context":{"trend4h":"LONG","trend1h":"LONG","structure15m":"未核验","entry5m":"未核验",
             "dailyFilter":"未核验","directionScore":80,"entryScore":80},
  "validation":{"similarityThreshold":85,"minimumClosed1mCandles":3,"maximumValidationMinutes":5,"atrTolerance":0.5}
}
```

5m 收盘价采用工程线性插值。价格分为 100×max(0,1−RMSE/(2×锁定 ATR))，总分为价格分 80% 与方向一致率 20%。方向中性容差为 ATR×0.02。硬失效使用已收盘 K 线的高低价，优先于相似度。画面上的范围是工程容差区间。

## 上线范围与回滚

本版为 SHADOW。符合路径的计划提示独立执行风控待复核。DEMO_AUTO、历史重放与阈值样本外对照尚待验收，现有 Binance Demo 订单生命周期未改动。100 个独立样本需要随时间采集。

先执行 D1 迁移，再更新 VPS 行情中继、Worker、MCP 和 Pages。回滚 Worker 后预测自然观测暂停，D1 保留所有记录；VPS 可恢复 `relay.py.before-pathmatch` 并重启行情服务。旧版模拟订单由原服务继续管理。
