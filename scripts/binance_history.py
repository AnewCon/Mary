from datetime import datetime, timedelta, timezone
from decimal import Decimal

BEIJING = timezone(timedelta(hours=8))
KINDS = {"REALIZED_PNL", "COMMISSION", "FUNDING_FEE"}


def account_history(fetch_income, reset_at=0):
    now = datetime.now(BEIJING)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    start = int((midnight - timedelta(days=6)).timestamp() * 1000)
    end = int(now.timestamp() * 1000)
    today = int(midnight.timestamp() * 1000)
    reset_at = reset_at if today <= reset_at <= end else 0
    rows = {}
    complete = False
    for page in range(1, 9):
        entries = fetch_income({"startTime": start, "endTime": end, "limit": 1000, "page": page})
        if not isinstance(entries, list):
            raise ValueError("Invalid income history")
        for row in entries:
            kind = row["incomeType"]
            if row["asset"] != "USDT" or kind not in KINDS:
                continue
            amount = Decimal(row["income"])
            timestamp = row["time"]
            if not amount.is_finite() or not isinstance(timestamp, int) or not start <= timestamp <= end:
                continue
            rows[(kind, str(row["tranId"]))] = {
                "symbol": row.get("symbol", ""), "income": format(amount, "f"), "asset": "USDT",
                "time": timestamp, "tranId": str(row["tranId"]), "kind": kind,
                "tradeId": str(row.get("tradeId", "")),
            }
        if len(entries) < 1000:
            complete = True
            break
    ordered = sorted(rows.values(), key=lambda row: row["time"], reverse=True)

    def totals(items):
        amounts = [Decimal(row["income"]) for row in items]
        return {"net": format(sum(amounts, Decimal(0)), "f"),
                "gains": format(sum((x for x in amounts if x > 0), Decimal(0)), "f"),
                "losses": format(sum((x for x in amounts if x < 0), Decimal(0)), "f")}

    return {"asOf": end, "dayStart": today, "rangeStart": start, "complete": complete,
            "resetAt": reset_at,
            "today": totals(row for row in ordered if row["time"] >= today and row["time"] > reset_at), "period": totals(ordered),
            "bills": ordered[:40], "closed": [row for row in ordered if row["kind"] == "REALIZED_PNL"][:40]}
