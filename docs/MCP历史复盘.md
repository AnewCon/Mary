# 历史复盘工具

新增 quantos_get_history，只需read权限。kind必填fills或bills，第一页省略cursor，后续沿用nextCursor。每页最多50条。返回已同步原始成交或账单、同步时间、范围、完整性、过期标志及收益口径。不会下单或强制同步。初次回溯最近90天后持续累计，不声称交易所全部历史。复盘时分别读取两种记录，累计收益使用quantos_get_performance，避免重复统计。

手机新建聊天重新选择QuantOS连接器，要求读取历史成交与收益账单并按游标翻页。
