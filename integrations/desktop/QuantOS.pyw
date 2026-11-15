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
from quantos_hello import HelloRequest, load_credentials, store_credentials

CLOUD = "https://marya-4j3.pages.dev/api/binance-live/agent/"
BINANCE = "https://fapi.binance.com"
TOKEN_FILE = Path(os.environ["LOCALAPPDATA"]) / "QuantOS" / "desktop.token"
HISTORY_FILE = TOKEN_FILE.with_name("binance-history.dpapi")

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
        root.geometry("760x615")
        root.minsize(660,580)
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
        ttk.Label(frame,text="币安 USDⓈ-M 真实账户  ·  本地签名与订单执行").grid(row=1,columnspan=3,sticky="w",pady=(4,15))
        self.fields={}
        for i,label in enumerate(("币安 API Key","币安 Secret Key","本机 HTTP 代理"),2):
            ttk.Label(frame,text=label).grid(row=i,column=0,sticky="w",padx=(0,12),pady=5)
            widget=ttk.Entry(frame,show="*" if i<4 else "")
            widget.grid(row=i,column=1,columnspan=2,sticky="ew",pady=5)
            self.fields[label]=widget
        ttk.Label(frame,text="直连此栏留空。仅按你选择的网络发送 请求。".replace("发送 请求","发送请求")).grid(row=5,columnspan=3,sticky="w",pady=(0,8))
        options=ttk.Frame(frame)
        options.grid(row=6,columnspan=3,sticky="ew",pady=(0,8))
        self.remember=tk.BooleanVar(value=False)
        self.remember_box=ttk.Checkbutton(options,text="连接成功后保存密钥到此电脑",variable=self.remember)
        self.remember_box.pack(side="left",padx=(0,10))
        self.history=ttk.Button(options,text="使用历史密钥",command=self.unlock_history)
        self.history.pack(side="left")
        self.history.configure(state="normal" if HISTORY_FILE.is_file() else "disabled")
        self.hello=None
        self.status=tk.StringVar(value="离线")
        ttk.Label(frame,textvariable=self.status).grid(row=7,columnspan=3,sticky="w",pady=6)
        self.summary=tk.StringVar(value="等待请求")
        ttk.Label(frame,textvariable=self.summary,wraplength=645).grid(row=9,columnspan=3,sticky="w",pady=(15,8))
        self.connect=tk.Button(frame,command=self.start,relief="flat",bd=0,
            font=("Microsoft YaHei UI",10,"bold"),padx=14,pady=7,cursor="hand2",
            highlightthickness=2,highlightbackground="#101c27",highlightcolor="#d7fff4")
        self.set_connection("idle")
        self.connect.grid(row=8,column=0,sticky="w")
        ttk.Label(frame,text="连接后自动执行 Chat 已确认的请求。关闭面板停止接收新请求。").grid(row=10,columnspan=3,sticky="w",pady=10)
        self.events=queue.Queue()
        self.stop=threading.Event()
        root.protocol("WM_DELETE_WINDOW",self.close)
        root.after(180,self.render)

    def set_connection(self,state):
        settings={
            "idle":("连接 QuantOS","#2563a7",tk.NORMAL),
            "connecting":("连接中…","#2563a7",tk.DISABLED),
            "connected":("已连接","#16734c",tk.DISABLED),
            "failed":("连接失败 · 重试","#a92f39",tk.NORMAL),
        }
        label,color,enabled=settings[state]
        self.connect.configure(text=label,bg=color,fg="#ffffff",activebackground=color,
                               activeforeground="#ffffff",disabledforeground="#ffffff",state=enabled)

    def unlock_history(self):
        if self.hello is not None or not HISTORY_FILE.is_file():
            return
        try:
            self.hello=HelloRequest(self.root.winfo_id())
        except OSError:
            messagebox.showerror("Windows Hello", "无法启动 Windows Hello。请检查 Windows 登录选项，或手动输入密钥。")
            return
        self.history.configure(state="disabled")
        self.connect.configure(state="disabled")
        self.root.after(160,self.poll_hello)

    def poll_hello(self):
        try:
            outcome=self.hello.poll()
        except OSError:
            outcome=False
        if outcome is None:
            self.root.after(160,self.poll_hello)
            return
        self.hello.close()
        self.hello=None
        self.history.configure(state="normal")
        self.connect.configure(state="normal")
        if not outcome:
            self.status.set("未通过 Windows Hello 验证，历史密钥保持锁定。")
            return
        try:
            key,secret=load_credentials(HISTORY_FILE)
        except (OSError,ValueError):
            messagebox.showerror("历史密钥", "无法用当前 Windows 用户读取历史密钥，请手动输入。")
            return
        for field,value in zip(list(self.fields.values())[:2],(key,secret)):
            field.delete(0,"end")
            field.insert(0,value)
        self.status.set("Windows Hello 验证通过，已填入历史密钥。")

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
            self.set_connection("failed")
            messagebox.showerror("未配对", "缺少 QuantOS 本机配对文件。")
            return
        for w in self.fields.values():
            w.delete(0,"end")
            w.configure(state="disabled")
        remember=self.remember.get()
        self.history.configure(state="disabled")
        self.remember_box.configure(state="disabled")
        self.set_connection("connecting")
        self.status.set("正在验证 API 权限及网络…")
        threading.Thread(target=self.run,args=(Connection(token,key,secret,proxy),bool(proxy),(key,secret) if remember else None),daemon=True).start()

    def run(self,c,proxied,remember=None):
        opened=False
        try:
            with c.opener.open(urllib.request.Request("https://www.cloudflare.com/cdn-cgi/trace",headers={"User-Agent":"QuantOS-Desktop/1.0"}),timeout=9) as r:
                ip=str(ipaddress.IPv4Address(next(l[3:] for l in r.read().decode().splitlines() if l.startswith("ip="))))
            c.snapshot()
            opened=True

            announced=False
            until=time.monotonic()+60
            while not self.stop.is_set():
                job=c.cloud("heartbeat",{"ready":True})
                if not announced:
                    self.events.put(("connection","connected"))
                    self.events.put(("status",f"在线 · {'本机代理' if proxied else '直连'} · 公网 IPv4 {ip}"))
                    announced=True
                    if remember:
                        try:
                            store_credentials(HISTORY_FILE,*remember)
                        except OSError:
                            self.events.put(("status","已连接 · 历史密钥保存失败"))
                        finally:
                            remember=None
                if self.stop.is_set():
                    break
                if job:
                    try:
                        claimed=c.cloud("claim",{"id":job["id"]})
                    except ApiError as error:
                        if error.code not in {"LIVE_REQUEST_UNAVAILABLE","LIVE_REQUEST_CONFLICT","LIVE_REQUEST_NOT_FOUND"}:
                            raise
                    else:
                        self.events.put(("order",f'执行中 · {claimed["order"]["symbol"]} · {claimed["id"]}'))
                        self.submit_claimed(c,claimed)
                        until=0
                if time.monotonic()>=until:
                    c.snapshot()
                    until=time.monotonic()+60
                self.stop.wait(5)
        except Exception as e:
            self.events.put(("status","连接失败 · "+error_code(e)))
        finally:
            if opened:
                try: c.cloud("heartbeat",{"ready":False})
                except Exception: pass
            self.events.put(("reset",None))

    def submit_claimed(self,c,job):
        if self.stop.is_set():
            c.cloud("result",{"id":job["id"],"state":"rejected","result":{"code":"DESKTOP_CLOSED_BEFORE_SUBMISSION"}})
            return
        try:
            outcome=c.execute(job)
        except Exception as error:
            code=error_code(error)
            definitive=isinstance(error,ApiError) and (
                isinstance(error.code,int) and -10000<error.code<-1000
                and error.code not in {-1001,-1006,-1007}
                or code in {"ONE_WAY_MODE_REQUIRED","OPPOSITE_POSITION_REQUIRES_REDUCE_ONLY"})
            c.cloud("result",{"id":job["id"],"state":"rejected" if definitive else "unknown","result":{"code":code}})
            self.events.put(("order",("订单未提交 · " if definitive else "结果未确认 · 请核对交易所 · ")+code))
        else:
            c.cloud("result",{"id":job["id"],"state":"accepted","result":outcome})
            self.events.put(("order","币安已回应 · 订单 "+outcome["orderId"]+" · "+str(outcome["status"])))

    def render(self):
        while not self.events.empty():
            kind,data=self.events.get()
            if kind=="connection": self.set_connection(data)
            if kind=="status": self.status.set(data)
            if kind=="order": self.summary.set(data)
            if kind=="reset":
                for field in self.fields.values(): field.configure(state="normal")
                self.history.configure(state="normal" if HISTORY_FILE.is_file() else "disabled")
                self.remember_box.configure(state="normal")
                self.set_connection("failed")
        self.root.after(180,self.render)

    def close(self):
        if self.hello:
            self.hello.close(cancel=True)
            self.hello=None
        self.stop.set()
        self.root.destroy()

if __name__=="__main__":
    root=tk.Tk()
    Panel(root)
    root.mainloop()
