import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from binance_limit_lifecycle import Lifecycle, TTL_MS


class Upstream(Exception):
    def __init__(self, code):
        self.code = code


class Demo:
    def __init__(self):
        self.status = "NEW"
        self.filled = "0"
        self.creation = 1780000000000
        self.position = None
        self.legs = {}
        self.cancels = 0
        self.race = False
        self.offline = False
        self.cancel_timeout = False
        self.fail_take_profit = False

    def exchange(self, path, method="GET", params=None):
        if self.offline:
            raise TimeoutError()
        if path.endswith("/order"):
            if method == "DELETE":
                self.cancels += 1
                if self.race:
                    self.status, self.filled = "FILLED", "1"
                    self.position = {"positionAmt": "1"}
                    raise Upstream(-2011)
                self.status = "CANCELED"
                if self.cancel_timeout:
                    raise TimeoutError()
            return {"symbol":"BTCUSDT","clientOrderId":"qos_"+"a"*32,
                    "status":self.status,"time":self.creation,"orderId":42,
                    "executedQty":self.filled,"avgPrice":"100","positionSide":"BOTH"}
        if method == "POST":
            if self.fail_take_profit and params["type"] == "TAKE_PROFIT_MARKET":
                raise Upstream(-2021)
            ident = params["clientAlgoId"]
            self.legs[ident] = {"algoStatus":"NEW","algoId":ident}
        elif method == "DELETE":
            self.legs[params["algoId"]]["algoStatus"] = "CANCELED"
        else:
            if params["clientAlgoId"] not in self.legs:
                raise Upstream(-2013)
            return dict(self.legs[params["clientAlgoId"]])

    def context(self, symbol, side):
        return False, "BOTH", self.position, bool(self.position)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.demo = Demo()
        self.reports = []
        self.manager = self.restart()
        self.id = "a" * 32
        self.file = self.folder / (self.id + ".json")
        self.job = {"id":self.id,"action":{"symbol":"BTCUSDT","side":"LONG","quantity":"1",
                                          "stopLoss":"90","takeProfit":"120","strategyVersion":"testing"}}
        self.submissions = 0

    def restart(self):
        return Lifecycle(self.folder,self.demo.exchange,self.demo.context,
                         lambda id,result:self.reports.append(json.loads(json.dumps(result))),Upstream)

    def begin(self):
        def execute(job):
            self.submissions += 1
        with patch("binance_limit_lifecycle.time.time", return_value=self.demo.creation/1000):
            return self.manager.begin(self.job, execute)

    def poll(self, elapsed=0):
        with patch("binance_limit_lifecycle.time.time", return_value=(self.demo.creation+elapsed)/1000):
            return self.manager.poll(self.file)

    def test_unfilled_expires_after_45_minutes(self):
        self.begin()
        self.assertEqual(self.poll(TTL_MS-1000)["orderState"],"NEW")
        r=self.poll(TTL_MS)
        self.assertEqual((r["orderState"],r["cancelResult"]),("CANCELED","CANCELED"))
        self.assertEqual(self.demo.cancels,1)

    def test_full_fill_not_canceled(self):
        self.demo.status,self.demo.filled,self.demo.position="FILLED","1",{"positionAmt":"1"}
        self.begin()
        self.assertEqual(self.poll(TTL_MS)["protectionState"],"armed")
        self.assertEqual(self.demo.cancels,0)

    def test_partial_cancels_remainder_and_protects_actual_position(self):
        self.demo.status,self.demo.filled,self.demo.position="PARTIALLY_FILLED","0.3",{"positionAmt":"0.3"}
        result=self.begin()
        self.assertEqual((result["orderState"],result["protectedPositionQuantity"]),("CANCELED","0.3"))
        self.assertEqual(result["protectionState"],"armed")

    def test_cancel_fill_race(self):
        self.demo.race=True
        self.begin()
        r=self.poll(TTL_MS)
        self.assertEqual((r["orderState"],r["cancelResult"],r["protectionState"]),("FILLED","FILLED","armed"))

    def test_restart_retains_exchange_deadline_and_order_identity(self):
        r=self.begin()
        self.manager=self.restart()
        self.assertEqual(self.poll()["expiresAt"],r["expiresAt"])
        self.begin()
        self.assertEqual(self.submissions,1)

    def test_offline_recovery(self):
        self.begin()
        self.demo.offline=True
        self.assertEqual(self.poll(TTL_MS)["orderState"],"ERROR")
        self.demo.offline=False
        self.assertEqual(self.poll(TTL_MS)["orderState"],"CANCELED")

    def test_cancel_timeout_still_confirms_without_resubmitting(self):
        self.demo.cancel_timeout=True
        self.begin()
        self.assertEqual(self.poll(TTL_MS)["orderState"],"CANCELED")
        self.assertEqual(self.demo.cancels,1)
        self.assertFalse(self.file.exists())

    def test_flat_position_cleans_residual_legs(self):
        self.demo.status,self.demo.filled,self.demo.position="FILLED","1",{"positionAmt":"1"}
        self.begin()
        self.demo.position=None
        self.assertEqual(self.poll()["protectionState"],"completed")
        self.assertTrue(all(x["algoStatus"]=="CANCELED" for x in self.demo.legs.values()))

    def test_failed_protection_blocks_new_entries(self):
        self.demo.status,self.demo.filled,self.demo.position="PARTIALLY_FILLED","0.3",{"positionAmt":"0.3"}
        self.demo.fail_take_profit=True
        self.assertEqual(self.begin()["protectionState"],"protection_error")
        self.assertTrue(self.manager.blocked())
        self.assertEqual(self.demo.status,"CANCELED")


if __name__=="__main__":
    unittest.main()
