
"""Local Windows Hello verification and current-user credential encryption."""
import ctypes as ct
import json
import uuid
from ctypes import wintypes
from pathlib import Path

com=ct.WinDLL("combase")
crypt=ct.WinDLL("crypt32",use_last_error=True)
kernel=ct.WinDLL("kernel32")
pointer=ct.c_void_p
out=ct.POINTER(pointer)
guid_size=ct.c_ubyte*16
factory_id="39e050c3-4e74-441a-8dc0-b81104df949c"
async_info_id="00000036-0000-0000-c000-000000000046"
async_namespace=uuid.UUID("11f47ad5-7b73-42c0-abae-878b1e16adee")
signature="pinterface({9fc2b0bb-e446-44e2-aa61-9cab8f636af2};enum(Windows.Security.Credentials.UI.UserConsentVerificationResult;i4))"
operation_id=str(uuid.uuid5(async_namespace,signature))

com.RoInitialize.argtypes=[ct.c_uint]
com.RoInitialize.restype=ct.c_long
com.RoUninitialize.argtypes=[]
com.WindowsCreateString.argtypes=[ct.c_wchar_p,ct.c_uint,out]
com.WindowsCreateString.restype=ct.c_long
com.WindowsDeleteString.argtypes=[pointer]
com.RoGetActivationFactory.argtypes=[pointer,pointer,out]
com.RoGetActivationFactory.restype=ct.c_long
ct.windll.user32.GetAncestor.argtypes=[wintypes.HWND,ct.c_uint]
ct.windll.user32.GetAncestor.restype=wintypes.HWND

def guid(value):
    return guid_size.from_buffer_copy(uuid.UUID(value).bytes_le)

def checked(hr):
    if hr<0: raise OSError(f"Windows Hello HRESULT 0x{hr & 0xffffffff:08X}")

def call(obj,slot,result,types,*args):
    table=ct.cast(obj,ct.POINTER(ct.POINTER(pointer))).contents
    return ct.WINFUNCTYPE(result,pointer,*types)(table[slot])(obj,*args)

def release(obj):
    if obj.value: call(obj,2,ct.c_ulong,())

class HelloRequest:
    def __init__(self, hwnd):
        self.operation=pointer()
        self.info=pointer()
        self.initialized=False
        source,message,factory=pointer(),pointer(),pointer()
        code=com.RoInitialize(0)
        if code<0 and code!=-2147417850: checked(code)
        self.initialized=code>=0
        try:
            name="Windows.Security.Credentials.UI.UserConsentVerifier"
            prompt="验证身份以解锁 QuantOS 历史密钥"
            checked(com.WindowsCreateString(name,len(name),ct.byref(source)))
            checked(com.WindowsCreateString(prompt,len(prompt),ct.byref(message)))
            checked(com.RoGetActivationFactory(source,ct.byref(guid(factory_id)),ct.byref(factory)))
            owner=ct.windll.user32.GetAncestor(hwnd,2) or hwnd
            checked(call(factory,6,ct.c_long,(wintypes.HWND,pointer,pointer,out),owner,message,
                         ct.byref(guid(operation_id)),ct.byref(self.operation)))
            checked(call(self.operation,0,ct.c_long,(pointer,out),ct.byref(guid(async_info_id)),ct.byref(self.info)))
        except BaseException:
            self.close()
            raise
        finally:
            release(factory)
            com.WindowsDeleteString(message)
            com.WindowsDeleteString(source)
    def poll(self):
        status=ct.c_int()
        checked(call(self.info,7,ct.c_long,(ct.POINTER(ct.c_int),),ct.byref(status)))
        if status.value==0: return None
        if status.value!=1: return False
        result=ct.c_int()
        checked(call(self.operation,8,ct.c_long,(ct.POINTER(ct.c_int),),ct.byref(result)))
        return result.value==0
    def close(self,cancel=False):
        if cancel and self.info.value:
            call(self.info,9,ct.c_long,())
        release(self.info)
        release(self.operation)
        self.info=pointer()
        self.operation=pointer()
        if self.initialized:
            com.RoUninitialize()
            self.initialized=False

class Blob(ct.Structure):
    _fields_=[("length",wintypes.DWORD),("data",pointer)]

blob_ptr=ct.POINTER(Blob)
crypt.CryptProtectData.argtypes=[blob_ptr,ct.c_wchar_p,blob_ptr,pointer,pointer,wintypes.DWORD,blob_ptr]
crypt.CryptUnprotectData.argtypes=[blob_ptr,out,blob_ptr,pointer,pointer,wintypes.DWORD,blob_ptr]
kernel.LocalFree.argtypes=[pointer]
kernel.LocalFree.restype=pointer

def dpapi(data,encrypt):
    raw=ct.create_string_buffer(data)
    incoming=Blob(len(data),ct.cast(raw,pointer))
    result=Blob()
    action=crypt.CryptProtectData if encrypt else crypt.CryptUnprotectData
    try:
        if not action(ct.byref(incoming),None,None,None,None,1,ct.byref(result)):
            raise ct.WinError(ct.get_last_error())
        return ct.string_at(result.data,result.length)
    finally:
        ct.memset(raw,0,len(data))
        if result.data:
            ct.memset(result.data,0,result.length)
            kernel.LocalFree(result.data)

def store_credentials(path:Path,key:str,secret:str):
    encrypted=dpapi(json.dumps([key,secret]).encode(),True)
    temp=path.with_suffix(".tmp")
    temp.write_bytes(encrypted)
    temp.replace(path)

def load_credentials(path:Path):
    values=json.loads(dpapi(path.read_bytes(),False))
    if not isinstance(values,list) or len(values)!=2 or not all(isinstance(x,str) and x for x in values):
        raise ValueError("Invalid saved credential")
    return tuple(values)
