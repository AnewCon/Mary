# QuantOS V2.3 模拟限价单

- 管理范围为 QuantOS 提交的 Binance USDⓈ-M 模拟限价入场单。VPS 在交易所确认创建后的 45 分钟触发撤单，并复查交易所状态。执行可能受网络或轮询延迟影响。VPS 重启沿用订单原创建时间。
- 新限价单通过 `binance_demo_place_bracket` 提交。填写止盈、止损和同一请求 ID。保护默认由标记价格触发，可指定 `CONTRACT_PRICE` 使用最新成交价。
- 部分成交会触发整仓止损和止盈检查，同时取消剩余数量。限价入场前要求该合约无仓位、挂单和保护单，成交后保护挂在实际持仓方向上。保护异常时取消余量、阻止新开仓并继续核对。处理期间可手动平仓，服务会核查并清理残留保护单。
- 交易所响应丢失后只查询原客户端订单号。禁止使用新编号重试未知结果。旧版可查到的活动限价单也会恢复跟踪，缺少历史保护价时显示异常。

## 部署与验收

1. 运行 `py tests/binance_limit_lifecycle_test.py` 和 `npm run build`，发布 QuantOS Worker、MCP Worker 和 Pages。
2. 将 `scripts/binance_limit_lifecycle.py` 和 `scripts/binance-push-agent.py` 上传到 VPS 的 `/opt/quantos-binance/`，后者安装为 `push.py`。用 Python 编译检查两个暂存文件后再替换，保留原 `push.py` 作回滚。
3. 重启并检查 `quantos-binance-push.service`，保持 `/var/lib/quantos-binance/brackets/` 和队列结果文件。检查网站模拟盘「限价订单」中的状态。
4. `QUANTOS_DEMO_LIMIT_ENABLED` 保持未设置或 `false`，直到模拟盘验收完成。回归场景使用可控的模拟响应，实接测试验证单独一笔 Demo 挂单从 NEW 到 CANCELED。测试时只推进隔离进程的到期判断时钟，生产时长仍为 45 分钟。
