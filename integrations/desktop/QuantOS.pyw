import hashlib
import hmac
import ipaddress
import json
import os
import queue
import threading
import time
import tkinter as tk
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal
from pathlib import Path
from tkinter import ttk, messagebox

CLOUD = "https://marya-4j3.pages.dev/api/binance-live/agent/"
BINANCE = "https://fapi.binance.com"
TOKEN_FILE = Path(os.environ["LOCALAPPDATA"]) / "QuantOS" / "desktop.token"

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

class ApiError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(str(code))

def client(proxy=None):
    return urllib.request.build_opener(urllib.request.ProxyHandler(
        {"https": proxy} if proxy else {}), NoRedirect())

def read_json(opener, url, *, method="GET", headers=None, data=None):
    req = urllib.request.Request(url, data=data, method=method,
        headers={"User-Agent":"QuantOS-Desktop/1.0", **(headers or {})})
    try:
        with opener.open(req, timeout=9) as response:
            return json.load(response)
    except urllib.error.HTTPError as e:
        try:
            body = json.load(e)
            code = body.get("code") or body.get("error",{}).get("code") or e.code
        except (ValueError, AttributeError):
            code = e.code
        raise ApiError(code) from None

class Connection:
    def __init__(self, token, key, secret, proxy):
        self.token, self.key, self.secret = token, key, secret.encode()
        self.opener = client(proxy)
    def cloud(self, operation, payload):
        result=read_json(self.opener,CLOUD+operation,method="POST",
            headers={"Authorization":"Bearer "+self.token,"Content-Type":"application/json"},
            data=json.dumps(payload).encode())
        if not result.get("ok"):
            raise ApiError("CLOUD_RESPONSE")
        return result["data"]
    def signed(self, path, params=None, method="GET"):
        allowed={("GET","/fapi/v3/account"),("GET","/fapi/v3/positionRisk"),
                 ("GET","/fapi/v1/positionSide/dual"),("POST","/fapi/v1/order")}
        if (method,path) not in allowed:
            raise ValueError("unsupported path")
        query=urllib.parse.urlencode({**(params or {}),"timestamp":int(time.time()*1000),"recvWindow":5000})
        signature=hmac.new(self.secret,query.encode(),hashlib.sha256).hexdigest()
        return read_json(self.opener,BINANCE+path+"?"+query+"&signature="+signature,
            method=method,headers={"X-MBX-APIKEY":self.key})
    def snapshot(self):
        account=self.signed("/fapi/v3/account")
        positions=self.signed("/fapi/v3/positionRisk")
        assets=[{k:a[k] for k in ("asset","walletBalance","availableBalance","marginBalance","unrealizedProfit")}
                for a in account["assets"] if a["asset"]=="USDT"]
        fields=("symbol","positionSide","positionAmt","marginAsset","entryPrice","markPrice","unRealizedProfit")
        self.cloud("snapshot",{"account":{"assets":assets},
            "positions":[{k:p[k] for k in fields} for p in positions if Decimal(p["positionAmt"])]})
    def execute(self, job):
        order=job["order"]
        if self.signed("/fapi/v1/positionSide/dual").get("dualSidePosition") is not False:
            raise ApiError("ONE_WAY_MODE_REQUIRED")
        if not order["reduceOnly"]:
            positions=self.signed("/fapi/v3/positionRisk",{"symbol":order["symbol"]})
            if any(Decimal(row["positionAmt"]) and
                   (Decimal(row["positionAmt"])>0)!=(order["side"]=="BUY") for row in positions):
                raise ApiError("OPPOSITE_POSITION_REQUIRES_REDUCE_ONLY")
        params={k:order[k] for k in ("symbol","side","type","quantity")}
        params.update(positionSide="BOTH",reduceOnly=str(order["reduceOnly"]).lower(),
                      newClientOrderId="qos_"+job["id"],newOrderRespType="RESULT")
        if order["type"]=="LIMIT":
            params.update(price=order["price"],timeInForce="GTC")
        data=self.signed("/fapi/v1/order",params,"POST")
        if data.get("clientOrderId")!=params["newClientOrderId"] or data.get("symbol")!=params["symbol"]:
            raise ApiError("UNVERIFIED_ORDER_RESPONSE")
        return {"orderId":str(data["orderId"]),"status":data.get("status"),"executedQty":data.get("executedQty")}

def error_code(error):
    return str(error.code) if isinstance(error,ApiError) else type(error).__name__

class Panel:
    def __init__(self,root):
        self.root=root
        root.title("QuantOS | 本地执行面板")
        root.geometry("760x565")
        root.minsize(660,525)
        root.configure(bg="#101c27")
        icon=Path(__file__).with_name("QuantOS.png")
        if icon.exists():
            self.icon=tk.PhotoImage(file=icon)
            root.iconphoto(True,self.icon)
        style=ttk.Style()
        style.theme_use("clam")
        style.configure("TFrame",background="#101c27")
        style.configure("TLabel",background="#101c27",foreground="#e6f3f1",font=("Microsoft YaHei UI",10))
        style.configure("Title.TLabel",font=("Microsoft YaHei UI",22,"bold"),foreground="#d7fff4")
        style.configure("TButton",font=("Microsoft YaHei UI",10),padding=7)
        style.configure("TCheckbutton",background="#101c27",foreground="#e6f3f1")
        frame=ttk.Frame(root,padding=22)
        frame.pack(fill="both",expand=True)
        frame.columnconfigure(1,weight=1)
        ttk.Label(frame,text="QuantOS 本地执行面板",style="Title.TLabel").grid(row=0,columnspan=3,sticky="w")
        ttk.Label(frame,text="币安 USDⓈ-M 真实账户  ·  本地签名与逐笔确认").grid(row=1,columnspan=3,sticky="w",pady=(4,15))
        self.fields={}
        for i,label in enumerate(("币安 API Key","币安 Secret Key","本机 HTTP 代理"),2):
            ttk.Label(frame,text=label).grid(row=i,column=0,sticky="w",padx=(0,12),pady=5)
            widget=ttk.Entry(frame,show="*" if i<4 else "")
            widget.grid(row=i,column=1,columnspan=2,sticky="ew",pady=5)
            self.fields[label]=widget
        ttk.Label(frame,text="直连此栏留空。仅按你选择的网络发送 请求。".replace("发送 请求","发送请求")).grid(row=5,columnspan=3,sticky="w",pady=(0,8))
        self.status=tk.StringVar(value="离线")
        ttk.Label(frame,textvariable=self.status).grid(row=6,columnspan=3,sticky="w",pady=6)
        self.summary=tk.StringVar(value="等待请求")
        ttk.Label(frame,textvariable=self.summary,wraplength=645).grid(row=8,columnspan=3,sticky="w",pady=(15,8))
        self.connect=ttk.Button(frame,text="连接 QuantOS",command=self.start)
        self.connect.grid(row=7,column=0,sticky="w")
        self.approve=ttk.Button(frame,text="确认并发送真实订单",command=lambda:self.decide(True),state="disabled")
        self.approve.grid(row=9,column=0,sticky="w")
        self.reject=ttk.Button(frame,text="拒绝",command=lambda:self.decide(False),state="disabled")
        self.reject.grid(row=9,column=1,sticky="w",padx=8)
        ttk.Label(frame,text="关闭面板会断开连接。已提交给币安的挂单仍由交易所管理。").grid(row=10,columnspan=3,sticky="w",pady=10)
        self.events=queue.Queue()
        self.decisions=queue.Queue()
        self.stop=threading.Event()
        self.job=None
        root.protocol("WM_DELETE_WINDOW",self.close)
        root.after(180,self.render)

    def start(self):
        key,secret,proxy=[w.get().strip() for w in self.fields.values()]
        if not key or not secret:
            messagebox.showinfo("配置", "请在此输入真实账户 API Key 与 Secret Key。")
            return
        if proxy:
            try:
                url=urllib.parse.urlsplit(proxy)
                if url.scheme!="http" or url.hostname not in {"127.0.0.1","localhost"} or not url.port or url.username or url.path not in {"","/"} or url.query or url.fragment:
                    raise ValueError()
            except ValueError:
                messagebox.showerror("配置", "代理必须是本机 HTTP 地址，例如 http://127.0.0.1:10809。")
                return
        try:
            token=TOKEN_FILE.read_text(encoding="ascii").strip()
        except OSError:
            messagebox.showerror("未配对", "缺少 QuantOS 本机配对文件。")
            return
        for w in self.fields.values():
            w.delete(0,"end")
            w.configure(state="disabled")
        self.connect.configure(state="disabled")
        self.status.set("正在验证 API 权限及网络…")
        threading.Thread(target=self.run,args=(Connection(token,key,secret,proxy),bool(proxy)),daemon=True).start()

    def run(self,c,proxied):
        opened=False
        try:
            with c.opener.open(urllib.request.Request("https://www.cloudflare.com/cdn-cgi/trace",headers={"User-Agent":"QuantOS-Desktop/1.0"}),timeout=9) as r:
                ip=str(ipaddress.IPv4Address(next(l[3:] for l in r.read().decode().splitlines() if l.startswith("ip="))))
            c.snapshot()
            opened=True
            self.events.put(("status",f"在线 · {'本机代理' if proxied else '直连'} · 公网 IPv4 {ip}"))
            until=time.monotonic()+60
            while not self.stop.is_set():
                job=c.cloud("heartbeat",{"ready":True})
                self.events.put(("job",job))
                try:
                    chosen,approved=self.decisions.get(timeout=12)
                except queue.Empty:
                    chosen=None
                if self.stop.is_set():
                    break
                if chosen:
                    if not approved:
                        c.cloud("result",{"id":chosen["id"],"state":"declined"})
                    else:
                        c.cloud("claim",{"id":chosen["id"]})
                        try:
                            outcome=c.execute(chosen)
                        except Exception as e:
                            code=error_code(e)
                            rejected=isinstance(e,ApiError) and (isinstance(e.code,int) and -10000<e.code<-1000 and e.code not in {-1001,-1006,-1007}
                                or code in {"ONE_WAY_MODE_REQUIRED","OPPOSITE_POSITION_REQUIRES_REDUCE_ONLY"})
                            c.cloud("result",{"id":chosen["id"],"state":"rejected" if rejected else "unknown","result":{"code":code}})
                            self.events.put(("status","订单结果 "+code))
                        else:
                            c.cloud("result",{"id":chosen["id"],"state":"accepted","result":outcome})
                            self.events.put(("status","币安已回应 · 订单 "+outcome["orderId"]+" · "+str(outcome["status"])))
                    self.events.put(("job",None))
                    until=0
                if time.monotonic()>=until:
                    c.snapshot()
                    until=time.monotonic()+60
        except Exception as e:
            self.events.put(("status","离线 · "+error_code(e)))
        finally:
            if opened:
                try: c.cloud("heartbeat",{"ready":False})
                except Exception: pass
            self.events.put(("reset",None))

    def render(self):
        while not self.events.empty():
            kind,data=self.events.get()
            if kind=="status": self.status.set(data)
            if kind=="job":
                self.job=data
                state="normal" if data else "disabled"
                self.approve.configure(state=state)
                self.reject.configure(state=state)
                if data:
                    o=data["order"]
                    purpose="只减仓" if o["reduceOnly"] else "开仓或同向加仓"
                    self.summary.set(f'{o["symbol"]} · {o["side"]} · {o["type"]} · {purpose}\n数量 {o["quantity"]}   限价 {o.get("price","—")}\n请求编号 {data["id"]}')
                else: self.summary.set("等待请求")
            if kind=="reset":
                self.job=None
                self.approve.configure(state="disabled")
                self.reject.configure(state="disabled")
                for w in self.fields.values(): w.configure(state="normal")
                self.connect.configure(state="normal")
        self.root.after(180,self.render)

    def decide(self,approved):
        if not self.job: return
        payload=self.job
        if approved and not messagebox.askyesno("确认真实交易",self.summary.get()+"\n\n发送到币安真实账户？",default="no"):
            return
        if not self.job or self.job["id"]!=payload["id"]:
            return
        self.approve.configure(state="disabled")
        self.reject.configure(state="disabled")
        self.decisions.put((payload,approved))

    def close(self):
        self.stop.set()
        self.root.destroy()

if __name__=="__main__":
    root=tk.Tk()
    Panel(root)
    root.mainloop()
