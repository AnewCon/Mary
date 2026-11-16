"""Durable lifecycle for QuantOS-managed Binance Demo limit entries."""
import json
import os
import time
from decimal import Decimal

TTL_MS = 45 * 60 * 1000
OPEN = {"NEW", "PARTIALLY_FILLED"}
TERMINAL = {"FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"}


def save(file, job):
    tmp = file.with_suffix(".tmp")
    with tmp.open("w", encoding="utf8") as stream:
        json.dump(job, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, file)
    if os.name != "nt":
        directory = os.open(file.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


def error_code(error):
    return str(getattr(error, "code", type(error).__name__))


def note(result, step, error):
    entry = {"time": int(time.time() * 1000), "step": step, "code": error_code(error)}
    errors = result.setdefault("errors", [])
    if not errors or (errors[-1]["step"], errors[-1]["code"]) != (entry["step"], entry["code"]):
        errors.append(entry)
        del errors[:-12]


class Lifecycle:
    def __init__(self, folder, exchange, context, report, upstream, clock_ms=None):
        self.folder = folder
        self.folder.mkdir(exist_ok=True)
        self.exchange = exchange
        self.context = context
        self.report = report
        self.upstream = upstream
        self.clock_ms = clock_ms or (lambda: int(time.time() * 1000))

    def files(self):
        return self.folder.glob("*.json")

    def blocked(self):
        # Before the next verified observation, retain the last known risk status.
        return any(json.loads(file.read_text()).get("result", {}).get("riskBlocked") for file in self.files())

    def begin(self, job, execute):
        file = self.folder / (job["id"] + ".json")
        if file.exists():
            return self.poll(file)
        action = job["action"]
        job["result"] = self.initial(action)
        job["submittedAt"] = time.time()
        save(file, job)  # Persist intent before the first submission; never resubmit it.
        try:
            execute({"id": job["id"], "bracketEntry": True, "action": {**action, "kind": "limit"}})
        except Exception as error:
            note(job["result"], "SUBMIT", error)
            save(file, job)
        # Always obtain the exchange creation time through the stable client order ID.
        return self.poll(file, publish=False)

    @staticmethod
    def initial(action):
        return {"orderState": "PENDING", "symbol": action["symbol"], "side": action["side"],
                "quantity": action["quantity"], "strategyVersion": action.get("strategyVersion", "legacy"),
                "triggerType": action.get("triggerType", "MARK_PRICE")}

    def publish(self, file, job, result, publish=True):
        job["result"] = result
        if json.loads(file.read_text()) != job:
            save(file, job)
        if publish and job.get("lastReport") != result:
            self.report(job["id"], result)
            # Deep copy so changes to nested errors/legs do not mutate the sent snapshot.
            job["lastReport"] = json.loads(json.dumps(result))
            save(file, job)
        return result

    def poll(self, file, publish=True, confirmed=None):
        job = json.loads(file.read_text())
        action = job["action"]
        result = job.get("result") or self.initial(action)
        symbol = action["symbol"]
        params = {"symbol": symbol, "origClientOrderId": "qos_" + job["id"]}
        before = result.get("exchangeStatus")
        try:
            order = confirmed if confirmed is not None else self.exchange("/fapi/v1/order", params=params)
            if order.get("symbol") != symbol or order.get("clientOrderId") != params["origClientOrderId"]:
                raise ValueError("unexpected order identity")
            status = order["status"]
            if status not in OPEN | TERMINAL or not isinstance(order["time"], int) or order["time"] <= 0:
                raise ValueError("unexpected order status or creation time")
            result.update(exchangeOrderId=str(order["orderId"]), orderState=(
                "EXPIRED" if status == "EXPIRED_IN_MATCH" else "ERROR" if status == "REJECTED" else status),
                exchangeStatus=status, createdAt=order["time"], expiresAt=order["time"] + TTL_MS,
                executedQuantity=str(order["executedQty"]), averagePrice=str(order["avgPrice"]))
            if status == "CANCELED":
                result["cancelResult"] = "CANCELED"
            elif status in TERMINAL:
                if result.get("cancelRequested"):
                    result["cancelResult"] = status
            filled = Decimal(order["executedQty"]) > 0
        except Exception as error:
            ambiguous = getattr(error, "code", None) == -2013
            job.setdefault("submittedAt", file.stat().st_mtime)
            recent = time.time() - job["submittedAt"] < 90
            result["orderState"] = "PENDING" if ambiguous and not before and recent else "ERROR"
            result["riskBlocked"] = bool(result.get("riskBlocked") or before not in {"CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"})
            note(result, "LOOKUP", error)
            return self.publish(file, job, result, publish)

        if filled:
            try:
                self.protect(job, order, result)
            except Exception as error:
                result.update(riskBlocked=True, protectionState="protection_error")
                note(result, "PROTECTION", error)
        else:
            result.update(riskBlocked=False, protectionState="waiting_fill")

        if status in OPEN and (filled or self.clock_ms() >= result["expiresAt"]):
            result.update(orderState="CANCEL_PENDING", cancelRequested=True)
            job["result"] = result
            save(file, job)  # Retain cancellation intent even if the request times out.
            try:
                self.exchange("/fapi/v1/order", "DELETE", {"symbol": symbol, "orderId": order["orderId"]})
            except Exception as error:
                note(result, "CANCEL", error)
            try:
                confirmed = self.exchange("/fapi/v1/order", params=params)
                if confirmed["status"] in TERMINAL:
                    save(file, job)
                    return self.poll(file, publish, confirmed)
            except Exception as error:
                note(result, "CANCEL_CONFIRM", error)

        # Keep monitoring an open position so the sibling protection is removed after exit.
        done = status in TERMINAL and (not filled or result.get("protectionState") == "completed")
        self.publish(file, job, result, publish)
        if done and publish:
            file.unlink(missing_ok=True)
        return result

    def protect(self, job, order, result):
        action = job["action"]
        symbol = action["symbol"]
        _, position_side, position, _ = self.context(symbol, action["side"])
        if order.get("positionSide") != position_side:
            raise ValueError("POSITION_MODE_MISMATCH")
        result["protectedPositionQuantity"] = str(abs(Decimal(position["positionAmt"]))) if position else "0"
        legs = {}
        for key, kind, suffix in (("stopLoss", "STOP_MARKET", "s"), ("takeProfit", "TAKE_PROFIT_MARKET", "t")):
            client_id = "qb" + job["id"] + suffix
            query = {"clientAlgoId": client_id}
            try:
                try:
                    current = self.exchange("/fapi/v1/algoOrder", params=query)
                except self.upstream as error:
                    if error.code not in {-2011, -2013}:
                        raise
                    current = None
                if position and current is None:
                    if not action.get(key):
                        raise ValueError("MISSING_PROTECTION_PRICE")
                    self.exchange("/fapi/v1/algoOrder", "POST", {
                        **query, "symbol": symbol, "side": "SELL" if action["side"] == "LONG" else "BUY",
                        "positionSide": position_side, "type": kind, "workingType": result["triggerType"],
                        "triggerPrice": action[key], "algoType": "CONDITIONAL", "closePosition": "true",
                    })
                    current = self.exchange("/fapi/v1/algoOrder", params=query)
                if not position and current and current["algoStatus"] in {"NEW", "TRIGGERING", "PENDING"}:
                    self.exchange("/fapi/v1/algoOrder", "DELETE", {"algoId": current["algoId"]})
                    current = self.exchange("/fapi/v1/algoOrder", params=query)
                legs[key] = {"status": current["algoStatus"], "algoId": str(current["algoId"])} if current else {"status": "ABSENT"}
            except Exception as error:
                legs[key] = {"status": "ERROR", "code": str(error) if isinstance(error, ValueError) else error_code(error)}
                note(result, key, error)
        result["protection"] = legs
        if position:
            armed = all(leg["status"] == "NEW" for leg in legs.values())
            result.update(riskBlocked=not armed, protectionState="armed" if armed else "protection_error")
        else:
            final = {"ABSENT", "CANCELED", "FINISHED", "EXPIRED", "REJECTED"}
            completed = all(leg["status"] in final for leg in legs.values())
            result.update(riskBlocked=not completed, protectionState="completed" if completed else "protection_error")
