const coin={type:'string',pattern:'^[A-Za-z0-9]{1,20}$',description:'币种代码，如 BTC、ETH 或 SOL。用数据源支持的币种代码。'};
const limit=(max:number)=>({type:'integer',minimum:1,maximum:max});
const make=(name:string,description:string,properties:Record<string,unknown>,required:string[])=>({
  name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}
});

export const marketTools=[
  make('quantos_market_liquidation_heatmap','读取 Blockmetric 的潜在清算热力图摘要。返回最新快照的多空重点价位和近期时段摘要，默认覆盖 Hyperliquid 的可追踪仓位。金额为估算值，不能当作已经爆仓。',{symbol:coin,limit:limit(12)},['symbol']),
  make('quantos_market_recent_liquidations','读取 MarginPad 已发生的近期爆仓事件。结果受覆盖和条数限制，不能视为全市场总额。',{symbol:coin,limit:limit(50)},['symbol']),
  make('quantos_market_overview','读取 CoinGecko 按市值排名的全市场行情。可按市值定面积、24 小时涨跌定颜色构造涨跌热力图。',{limit:limit(50)},[]),
  make('quantos_market_derivatives','读取 Bybit USDT 合约资金费率、未平仓量及一小时账户多空比。费率为小数比例。',{symbol:coin},['symbol'])
];
export const marketPaths:Record<string,string>={
  quantos_market_liquidation_heatmap:'heatmap',quantos_market_recent_liquidations:'liquidations',
  quantos_market_overview:'overview',quantos_market_derivatives:'derivatives'
};
