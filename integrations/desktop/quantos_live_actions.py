from decimal import Decimal
import re


READ_ACTIONS = {"orders", "contract", "query"}
SIGNED_ENDPOINTS = {
    ("GET", "/fapi/v1/symbolConfig"),
    ("GET", "/fapi/v1/openOrders"),
    ("GET", "/fapi/v1/openAlgoOrders"),
    ("GET", "/fapi/v1/allOrders"),
    ("GET", "/fapi/v1/order"),
    ("POST", "/fapi/v1/order"),
    ("DELETE", "/fapi/v1/order"),
    ("GET", "/fapi/v1/algoOrder"),
    ("POST", "/fapi/v1/algoOrder"),
    ("DELETE", "/fapi/v1/algoOrder"),
    ("POST", "/fapi/v1/leverage"),
}


class LiveValidationError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def contract_info(connection, symbol):
    for item in connection.exchange_info()["symbols"]:
        if item["symbol"] == symbol and item.get("quoteAsset") == "USDT":
            return item
    raise LiveValidationError("CONTRACT_NOT_FOUND")


def sizing(position, percent, contract):
    filters = {row["filterType"]: row for row in contract["filters"]}
    lot = filters["LOT_SIZE"]
    market = filters["MARKET_LOT_SIZE"]
    step = Decimal(market["stepSize"]) or Decimal(lot["stepSize"])
    maximum = min(value for value in (Decimal(market["maxQty"]), Decimal(lot["maxQty"])) if value > 0)
    quantity = (abs(position) * percent / 100 // step) * step
    if quantity > maximum:
        raise LiveValidationError("CLOSE_QUANTITY_ABOVE_MAX")
    if quantity <= 0 or quantity < max(Decimal(market["minQty"]), Decimal(lot["minQty"])):
        raise LiveValidationError("CLOSE_QUANTITY_BELOW_MIN")
    return format(quantity, "f")


def exchange_ids(order):
    return {key: str(value) if key in {"orderId", "algoId", "actualOrderId"} and value is not None else value
            for key, value in order.items()}


def execute_action(connection, job):
    action = job["action"]
    kind, symbol = action["kind"], action["symbol"]
    if not re.fullmatch(r"[A-Z0-9]{2,24}USDT", symbol) or not re.fullmatch(r"[a-f0-9]{32}", job["id"]):
        raise LiveValidationError("LIVE_INVALID_ACTION")
    signed = connection.signed
    market = {"symbol": symbol}
    if kind == "contract":
        info = contract_info(connection, symbol)
        return {
            "symbol": symbol,
            "status": info["status"],
            "contractType": info["contractType"],
            "filters": info["filters"],
            "configuration": signed("/fapi/v1/symbolConfig", market),
            "positionMode": signed("/fapi/v1/positionSide/dual"),
        }
    if kind == "orders":
        return {
            "openOrders": [exchange_ids(row) for row in signed("/fapi/v1/openOrders", market)[:20]],
            "openProtection": [exchange_ids(row) for row in signed("/fapi/v1/openAlgoOrders", market)[:20]],
            "recentOrders": [exchange_ids(row) for row in signed("/fapi/v1/allOrders", {**market, "limit": 10})],
        }
    if kind in {"query", "cancel"}:
        order_id = action["exchangeOrderId"]
        if not re.fullmatch(r"[0-9]{1,22}", order_id):
            raise LiveValidationError("INVALID_ORDER_ID")
        if action.get("conditional") is True:
            params = {"algoId": order_id}
            current = signed("/fapi/v1/algoOrder", params)
            if current.get("symbol") != symbol:
                raise LiveValidationError("ORDER_SYMBOL_MISMATCH")
            return exchange_ids(current if kind=="query" else signed("/fapi/v1/algoOrder", params, "DELETE"))
        params = {**market, "orderId": order_id}
        return exchange_ids(signed("/fapi/v1/order", params, "GET" if kind == "query" else "DELETE"))
    if kind == "leverage":
        leverage = action["leverage"]
        if type(leverage) is not int or not 1 <= leverage <= 125:
            raise LiveValidationError("INVALID_LEVERAGE")
        return signed("/fapi/v1/leverage", {**market, "leverage": leverage}, "POST")
    if kind not in {"open", "limit", "close", "protect"} or action.get("side") not in {"LONG", "SHORT"}:
        raise LiveValidationError("LIVE_INVALID_ACTION")
    direction = action["side"]
    long = direction == "LONG"
    hedge = signed("/fapi/v1/positionSide/dual").get("dualSidePosition")
    if type(hedge) is not bool:
        raise LiveValidationError("POSITION_MODE_UNAVAILABLE")
    position_side = direction if hedge else "BOTH"
    positions = signed("/fapi/v3/positionRisk", market)
    amount = next((Decimal(row["positionAmt"]) for row in positions
                   if row["symbol"] == symbol and row.get("positionSide") == position_side), Decimal(0))
    side = "SELL" if long else "BUY"
    client_id = "qos_" + job["id"]
    params = {**market, "positionSide": position_side, "newClientOrderId": client_id, "newOrderRespType": "RESULT"}

    if kind in {"open", "limit"}:
        if not hedge and amount and (amount > 0) != long:
            raise LiveValidationError("OPPOSITE_POSITION_REQUIRES_REDUCE_ONLY")
        params.update(side="BUY" if long else "SELL", type="MARKET", quantity=action["quantity"])
        if kind == "limit":
            params.update(type="LIMIT", price=action["price"], timeInForce="GTC")
        return submit_order(signed, params)

    if not amount or (not hedge and (amount > 0) != long):
        raise LiveValidationError("POSITION_CHANGED")
    if kind == "close":
        percent = action["percent"]
        if type(percent) is not int or not 1 <= percent <= 100:
            raise LiveValidationError("INVALID_PERCENT")
        params.update(side=side, type="MARKET", quantity=sizing(amount, percent, contract_info(connection, symbol)))
        if not hedge:
            params["reduceOnly"] = "true"
        return submit_order(signed, params)

    protection = action["protection"]
    trigger = Decimal(action["triggerPrice"])
    if protection not in {"STOP_MARKET", "TAKE_PROFIT_MARKET"} or not trigger.is_finite() or trigger <= 0:
        raise LiveValidationError("INVALID_PROTECTION")
    current = signed("/fapi/v1/openAlgoOrders", market)
    if any(row.get("positionSide") == position_side and row.get("side") == side and row.get("orderType") == protection
           and row.get("closePosition") in (True, "true") for row in current):
        raise LiveValidationError("PROTECTION_ALREADY_EXISTS")
    result = signed("/fapi/v1/algoOrder", {
        **market, "algoType": "CONDITIONAL", "side": side, "positionSide": position_side,
        "type": protection, "workingType": "MARK_PRICE", "triggerPrice": format(trigger, "f"),
        "closePosition": "true", "clientAlgoId": client_id,
    }, "POST")
    if result.get("symbol") != symbol or result.get("clientAlgoId") != client_id:
        raise RuntimeError("UNVERIFIED_PROTECTION_RESPONSE")
    return exchange_ids(result)


def submit_order(signed, params):
    result = signed("/fapi/v1/order", params, "POST")
    if result.get("clientOrderId") != params["newClientOrderId"] or result.get("symbol") != params["symbol"]:
        raise RuntimeError("UNVERIFIED_ORDER_RESPONSE")
    return exchange_ids(result)
