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
from tkinter import ttk, messagebox, simpledialog
from quantos_hello import HelloRequest
from quantos_live_actions import execute_action, LiveValidationError, READ_ACTIONS, SIGNED_ENDPOINTS
from quantos_usb_cue import UsbCue
from quantos_usb import removable_drives, existing_usb_key, usb_load, usb_store
from quantos_gate import ADMIN, BOUND, admin_matches, bound_usb, pairing_token, register, PreviousUsbMissing

CLOUD = "https://marya-4j3.pages.dev/api/binance-live/agent/"
BINANCE = "https://fapi.binance.com"
TOKEN_FILE = Path(os.environ["LOCALAPPDATA"]) / "QuantOS" / "desktop.token"
HISTORY_FILE = TOKEN_FILE.with_name("binance-history.dpapi")
PROXY_FILE = TOKEN_FILE.with_name("last-proxy.json")

def valid_proxy(proxy):
    if not proxy:
        return True
    try:
        url=urllib.parse.urlsplit(proxy)
        return (url.scheme=="http" and url.hostname in {"127.0.0.1","localhost"} and bool(url.port)
                and not url.username and not url.password and url.path in {"","/"}
                and not url.query and not url.fragment)
    except ValueError:
        return False

def load_proxy():
    try:
        value=json.loads(PROXY_FILE.read_text(encoding="utf8"))["proxy"]
        return value if isinstance(value,str) and valid_proxy(value) else ""
    except (OSError,ValueError,KeyError,TypeError):
        return ""

def save_proxy(value):
    temp=PROXY_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps({"proxy":value}),encoding="utf8")
    temp.replace(PROXY_FILE)

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
        if (method,path) not in allowed | SIGNED_ENDPOINTS:
            raise ValueError("unsupported path")
        query=urllib.parse.urlencode({**(params or {}),"timestamp":int(time.time()*1000),"recvWindow":5000})
        signature=hmac.new(self.secret,query.encode(),hashlib.sha256).hexdigest()
        return read_json(self.opener,BINANCE+path+"?"+query+"&signature="+signature,
            method=method,headers={"X-MBX-APIKEY":self.key})
    def exchange_info(self):
        return read_json(self.opener,BINANCE+"/fapi/v1/exchangeInfo")
    def snapshot(self):
        account=self.signed("/fapi/v3/account")
        positions=self.signed("/fapi/v3/positionRisk")
        assets=[{k:a[k] for k in ("asset","walletBalance","availableBalance","marginBalance","unrealizedProfit")}
                for a in account["assets"] if a["asset"]=="USDT"]
        fields=("symbol","positionSide","positionAmt","marginAsset","entryPrice","markPrice","unRealizedProfit")
        self.cloud("snapshot",{"account":{"assets":assets},
            "positions":[{k:p[k] for k in fields} for p in positions if Decimal(p["positionAmt"])]})
    def execute(self, job):
        if "action" in job:
            return execute_action(self,job)
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
        return {"orderId":str(data["orderId"]),"status":data.get("status"),"executedQty":data.get("executedQty"),"avgPrice":data.get("avgPrice"),"symbol":data["symbol"]}

def error_code(error):
    return str(error.code) if isinstance(error,(ApiError,LiveValidationError)) else type(error).__name__

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
        ttk.Label(frame,text="QuantOS 本地执行面板",style="Title.TLabel").grid(row=0,columnspan=2,sticky="w")
        ttk.Label(frame,text="币安 USDⓈ-M 真实账户  ·  本地签名与订单执行").grid(row=1,columnspan=2,sticky="w",pady=(4,15))
        self.usb_cue=UsbCue(frame)
        self.usb_cue.grid(row=0,column=2,rowspan=2,sticky="ne",pady=(0,12))
        self.fields={}
        for i,label in enumerate(("币安 API Key","币安 Secret Key","本机 HTTP 代理"),2):
            ttk.Label(frame,text=label).grid(row=i,column=0,sticky="w",padx=(0,12),pady=5)
            widget=ttk.Entry(frame,show="*" if i<4 else "")
            widget.grid(row=i,column=1,columnspan=2,sticky="ew",pady=5)
            self.fields[label]=widget
        self.proxy_field=self.fields["本机 HTTP 代理"]
        self.proxy_field.insert(0,load_proxy())
        ttk.Label(frame,text="连接成功后记住代理地址。直连请留空。").grid(row=5,columnspan=3,sticky="w",pady=(0,8))
        options=ttk.Frame(frame)
        options.grid(row=6,columnspan=3,sticky="ew",pady=(0,8))
        self.remember=tk.BooleanVar(value=False)
        self.remember_box=ttk.Checkbutton(options,text="连接成功后保存密钥到此电脑",variable=self.remember)
        self.remember_box.pack(side="left",padx=(0,10))
        self.history=ttk.Button(options,text="使用历史密钥",command=self.unlock_history)
        self.history.pack(side="left",padx=(0,10))
        self.usb_button=ttk.Button(options,text="登记 U 盘",command=self.register_usb)
        self.usb_button.pack(side="left")
        self.hello_request=None
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
        self.disconnect_button=ttk.Button(frame,text="断开连接",command=self.disconnect)
        self.disconnect_button.grid(row=8,column=1,sticky="w",padx=(10,0))
        self.disconnect_button.grid_remove()
        ttk.Label(frame,text="连接后自动执行 Chat 已确认的请求。关闭面板停止接收新请求。").grid(row=10,columnspan=3,sticky="w",pady=10)
        self.events=queue.Queue()
        self.stop=threading.Event()
        self.worker_active=False
        self.closing=False
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

    def register_usb(self):
        if self.worker_active or self.hello is not None:
            return
        if BOUND.is_file():
            messagebox.showinfo("登记 U 盘","已登记。此面板不提供直接覆盖。")
            return
        if not ADMIN.is_file():
            messagebox.showinfo("登记 U 盘","请先由管理员在本机部署登记 Key。")
            return
        admin=simpledialog.askstring("登记 U 盘","输入专用管理员 Key：",show="*",parent=self.root)
        if admin is None:
            return
        if not admin_matches(admin):
            messagebox.showerror("登记 U 盘","管理员 Key 不正确。")
            return
        drives=removable_drives()
        if not drives:
            messagebox.showinfo("登记 U 盘","未检测到可移动 U 盘，请插入后重试。")
            return
        labels={drive.drive.upper():drive for drive in drives}
        if len(drives)==1:
            root=drives[0]
        else:
            selection=simpledialog.askstring("登记 U 盘","请输入要登记的盘符："+ "、".join(labels),parent=self.root)
            if not selection:
                return
            root=labels.get(selection.strip().upper().rstrip(":")+":")
            if root is None:
                messagebox.showerror("登记 U 盘","请选择列表中的可移动磁盘。")
                return
        if messagebox.askyesno("登记 U 盘",f"将验证文件写入 {root}。以后解锁历史密钥需要这个 U 盘和 Windows Hello。继续？",default="no"):
            self.begin_hello(("enroll",root))

    def unlock_history(self):
        if self.worker_active or self.hello is not None or not HISTORY_FILE.is_file():
            return
        try:
            required,key=existing_usb_key(HISTORY_FILE)
        except OSError:
            messagebox.showerror("历史密钥","无法读取历史密钥文件。")
            return
        if required and key is None:
            self.status.set("请插入已登记的 U 盘，再使用历史密钥。")
            return
        self.begin_hello(("unlock",None))

    def begin_hello(self,request):
        try:
            self.hello=HelloRequest(self.root.winfo_id())
        except OSError:
            messagebox.showerror("Windows Hello", "无法启动 Windows Hello。请检查 Windows 登录选项，或手动输入密钥。")
            return
        self.hello_request=request
        for button in (self.history,self.connect,self.usb_button):
            button.configure(state="disabled")
        self.root.after(160,self.poll_hello)

    def poll_hello(self):
        request=self.hello
        try:
            outcome=request.poll()
        except OSError:
            outcome=False
        if outcome is None:
            self.root.after(160,self.poll_hello)
            return
        try:
            request.close()
        finally:
            self.hello=None
            for field in self.fields.values():
                field.configure(state="normal")
                field.state(["!disabled","!readonly"])
            for button in (self.history,self.connect,self.usb_button):
                button.configure(state="normal")
            self.root.after_idle(self.focus_proxy)
            action,target=self.hello_request
            self.hello_request=None
        if not outcome:
            self.status.set("未通过 Windows Hello 验证，历史密钥保持锁定。")
            return
        if action=="enroll":
            replace_history=False
            if HISTORY_FILE.is_file():
                try:
                    required,previous=existing_usb_key(HISTORY_FILE)
                except OSError:
                    messagebox.showerror("登记 U 盘","无法读取本机的历史密钥文件。")
                    return
                if required and previous is None:
                    replace_history=messagebox.askyesno("原 U 盘不在电脑上",
                        "旧的历史密钥只能用原 U 盘解锁。是否保留旧密钥的加密备份，改用当前 U 盘？换绑后需重新输入币安 API 密钥。",
                        default="no",parent=self.root)
                    if not replace_history:
                        return
            try:
                register(target,replace_missing_history=replace_history)
            except PreviousUsbMissing:
                messagebox.showerror("登记 U 盘","未找到原 U 盘，请插入原盘或选择换绑。")
            except FileExistsError:
                messagebox.showerror("登记 U 盘","该 U 盘已有验证文件，未覆盖。请选择另一只 U 盘。")
            except PermissionError:
                messagebox.showerror("登记 U 盘","系统拒绝写入。请检查 U 盘写保护和当前用户权限。")
            except ValueError:
                messagebox.showerror("登记 U 盘","所选 U 盘与旧历史密钥不匹配，请选择原来登记的 U 盘。")
            except OSError:
                messagebox.showerror("登记 U 盘","登记失败，请确认 U 盘仍插着，本机配对文件可以读取。")
            else:
                self.history.configure(state="normal" if HISTORY_FILE.is_file() else "disabled")
                self.status.set("换绑成功。请重新输入币安 API 密钥。" if replace_history else
                    "U 盘登记成功。连接时需插入 U 盘并通过 Windows Hello。")
            return
        if action=="connect":
            current=bound_usb()
            if current is None or not hmac.compare_digest(current,target[0]):
                self.status.set("连接已取消 · U 盘验证未通过")
                return
            try:
                pairing=pairing_token(current)
            except (OSError,ValueError):
                self.status.set("连接已取消 · 无法读取配对凭证")
                return
            self.connect_authenticated(pairing,current,*target[1:])
            return
        try:
            required,token=existing_usb_key(HISTORY_FILE)
            if required and token is None:
                self.status.set("未找到已登记的 U 盘，历史密钥保持锁定。")
                return
            key,secret=usb_load(HISTORY_FILE,token)
        except (OSError,ValueError):
            messagebox.showerror("历史密钥", "无法用当前 Windows 用户读取历史密钥，请手动输入。")
            return
        for field,value in zip(list(self.fields.values())[:2],(key,secret)):
            field.delete(0,"end")
            field.insert(0,value)
        self.status.set("验证通过。可编辑密钥或代理，再点连接。")

    def focus_proxy(self):
        if not self.closing:
            self.root.lift()
            self.proxy_field.focus_force()
            self.proxy_field.icursor("end")

    def start(self):
        if self.worker_active or self.hello is not None:
            return
        key,secret,proxy=[w.get().strip() for w in self.fields.values()]
        if not key or not secret:
            messagebox.showinfo("配置", "请在此输入真实账户 API Key 与 Secret Key。")
            return
        if not valid_proxy(proxy):
            messagebox.showerror("配置", "代理必须是本机 HTTP 地址，例如 http://127.0.0.1:10809。")
            return
        usb=bound_usb()
        if usb is None:
            self.status.set("请先插入已登记的 U 盘，再连接 QuantOS。")
            return
        self.begin_hello(("connect",(usb,key,secret,proxy)))

    def connect_authenticated(self,token,usb,key,secret,proxy):
        connection=Connection(token,key,secret,proxy)
        self.stop.clear()
        self.worker_active=True
        for field in list(self.fields.values())[:2]:
            field.delete(0,"end")
        self.disconnect_button.configure(state="normal")
        self.disconnect_button.grid()
        remember=self.remember.get()
        self.history.configure(state="disabled")
        self.remember_box.configure(state="disabled")
        self.usb_button.configure(state="disabled")
        self.set_connection("connecting")
        self.status.set("正在验证 API 权限及网络…")
        threading.Thread(target=self.run,args=(connection,proxy,usb,(key,secret) if remember else None),daemon=True).start()

    def run(self,c,proxy,usb,remember=None):
        opened=False
        offline_confirmed=False
        usb_removed=False
        try:
            with c.opener.open(urllib.request.Request("https://www.cloudflare.com/cdn-cgi/trace",headers={"User-Agent":"QuantOS-Desktop/1.0"}),timeout=9) as r:
                ip=str(ipaddress.IPv4Address(next(l[3:] for l in r.read().decode().splitlines() if l.startswith("ip="))))
            if self.stop.is_set():
                return
            if bound_usb()!=usb:
                usb_removed=True
                return
            c.snapshot()
            opened=True

            announced=False
            until=time.monotonic()+60
            while not self.stop.is_set():
                if not announced and bound_usb()!=usb:
                    usb_removed=True
                    break
                job=c.cloud("heartbeat",{"ready":True,"version":2})
                if not announced:
                    self.events.put(("connection","connected"))
                    self.events.put(("status",f"在线 · {'本机代理' if proxy else '直连'} · 公网 IPv4 {ip}"))
                    announced=True
                    try:
                        save_proxy(proxy)
                    except OSError:
                        self.events.put(("status","已连接 · 无法保存代理地址"))
                    if remember:
                        try:
                            usb_store(HISTORY_FILE,*remember,usb)
                        except (OSError,ValueError):
                            self.events.put(("status","已连接 · 历史密钥未更新，请检查已登记的 U 盘"))
                        finally:
                            remember=None
                if self.stop.is_set():
                    break
                if job:
                    try:
                        claimed=c.cloud("claim",{"id":job["id"],"version":2})
                    except ApiError as error:
                        if error.code not in {"LIVE_REQUEST_UNAVAILABLE","LIVE_REQUEST_CONFLICT","LIVE_REQUEST_NOT_FOUND"}:
                            raise
                    else:
                        self.events.put(("order",f'执行中 · {(claimed.get("order") or claimed["action"])["symbol"]} · {claimed["id"]}'))
                        self.submit_claimed(c,claimed)
                        until=0
                if self.stop.is_set():
                    break
                if time.monotonic()>=until:
                    c.snapshot()
                    until=time.monotonic()+60
                self.stop.wait(5)
        except Exception as e:
            self.events.put(("status","连接失败 · "+error_code(e)))
        finally:
            if opened:
                try:
                    c.cloud("heartbeat",{"ready":False,"version":2})
                    offline_confirmed=True
                except Exception:
                    pass
            self.events.put(("reset",(self.stop.is_set() or usb_removed,opened,offline_confirmed,usb_removed)))

    def submit_claimed(self,c,job):
        if self.stop.is_set():
            c.cloud("result",{"id":job["id"],"state":"rejected","result":{"code":"DESKTOP_CLOSED_BEFORE_SUBMISSION"}})
            return
        try:
            outcome=c.execute(job)
        except Exception as error:
            code=error_code(error)
            is_read=job.get("action",{}).get("kind") in READ_ACTIONS
            definitive=is_read or isinstance(error,LiveValidationError) or isinstance(error,ApiError) and (
                isinstance(error.code,int) and -10000<error.code<-1000
                and error.code not in {-1001,-1006,-1007}
                or code in {"ONE_WAY_MODE_REQUIRED","OPPOSITE_POSITION_REQUIRES_REDUCE_ONLY"})
            c.cloud("result",{"id":job["id"],"state":"rejected" if definitive else "unknown","result":{"code":code}})
            self.events.put(("order",("订单未提交 · " if definitive else "结果未确认 · 请核对交易所 · ")+code))
        else:
            c.cloud("result",{"id":job["id"],"state":"accepted","result":outcome})
            exchange_id=outcome.get("orderId") or outcome.get("algoId")
            detail=f" · 编号 {exchange_id}" if exchange_id else ""
            self.events.put(("order","币安已回应"+detail))

    def render(self):
        while not self.events.empty():
            kind,data=self.events.get()
            if kind=="connection" and not self.stop.is_set(): self.set_connection(data)
            if kind=="status" and not self.stop.is_set(): self.status.set(data)
            if kind=="order": self.summary.set(data)
            if kind=="reset":
                stopped,opened,notified,usb_removed=data
                self.worker_active=False
                self.disconnect_button.grid_remove()
                if self.closing:
                    self.root.destroy()
                    return
                for field in self.fields.values(): field.configure(state="normal")
                self.history.configure(state="normal" if HISTORY_FILE.is_file() else "disabled")
                self.remember_box.configure(state="normal")
                self.usb_button.configure(state="normal")
                self.set_connection("idle" if stopped else "failed")
                if stopped:
                    self.status.set("已断开 · 已通知 QuantOS" if notified else
                        "已断开 · 网站将按心跳超时更新状态" if opened else "已取消连接")
                if usb_removed:
                    self.status.set("U 盘已拔出 · "+self.status.get())
                if not stopped and opened and not notified:
                    self.status.set(self.status.get()+" · 网站将按心跳超时更新状态")
        self.root.after(180,self.render)

    def disconnect(self):
        if not self.worker_active:
            return
        self.stop.set()
        self.disconnect_button.configure(state="disabled")
        self.status.set("正在断开并通知 QuantOS…")

    def close(self):
        if self.hello:
            self.hello.close(cancel=True)
            self.hello=None
        if self.worker_active:
            self.closing=True
            self.disconnect()
            return
        self.root.destroy()

if __name__=="__main__":
    root=tk.Tk()
    Panel(root)
    root.mainloop()
