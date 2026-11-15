
"""USB possession factor for QuantOS saved credentials."""
import ctypes as ct
import hashlib
import hmac
import os
import secrets
from pathlib import Path

from quantos_hello import dpapi

USB_FILENAME="QuantOS-USB.key"
MAGIC=b"QuantOS-USB-v1\x00"
kernel=ct.WinDLL("kernel32",use_last_error=True)
kernel.GetLogicalDrives.restype=ct.c_uint
kernel.GetDriveTypeW.argtypes=[ct.c_wchar_p]
kernel.GetDriveTypeW.restype=ct.c_uint

def removable_drives():
    drives=kernel.GetLogicalDrives()
    roots=[f"{chr(65+i)}:\\" for i in range(26) if drives & (1<<i)]
    return [Path(root) for root in roots if kernel.GetDriveTypeW(root)==2]

def token_matches(root,expected):
    try:
        with (root/USB_FILENAME).open("rb") as file:
            token=file.read(33)
        if len(token)==32 and hmac.compare_digest(hashlib.sha256(token).digest(),expected):
            return token
    except OSError:
        pass
    return None

def existing_usb_key(history):
    with history.open("rb") as file:
        header=file.read(len(MAGIC)+32)
    if not header.startswith(MAGIC):
        return False,None
    expected=header[len(MAGIC):]
    if len(expected)==32:
        for root in removable_drives():
            token=token_matches(root,expected)
            if token is not None:
                return True,token
    return True,None

def usb_load(history,token):
    contents=history.read_bytes()
    if contents.startswith(MAGIC):
        expected=contents[len(MAGIC):len(MAGIC)+32]
        if token is None or not hmac.compare_digest(hashlib.sha256(token).digest(),expected):
            raise ValueError("USB verification required")
        contents=contents[len(MAGIC)+32:]
    else:
        token=None
    import json
    values=json.loads(dpapi(contents,False,token))
    if not isinstance(values,list) or len(values)!=2 or not all(isinstance(item,str) and item for item in values):
        raise ValueError("Invalid saved credential")
    return tuple(values)

def usb_store(history,key,secret,token):
    import json
    if token is None:
        raise ValueError("USB verification required")
    content=MAGIC+hashlib.sha256(token).digest()+dpapi(json.dumps([key,secret]).encode(),True,token)
    temp=history.with_suffix(".usb.tmp")
    temp.write_bytes(content)
    temp.replace(history)

def enroll(history,root):
    if root not in removable_drives():
        raise OSError("USB no longer available")
    required,_=existing_usb_key(history)
    if required:
        raise ValueError("USB already registered")
    key,secret=usb_load(history,None)
    token=secrets.token_bytes(32)
    path=root/USB_FILENAME
    created=False
    try:
        with path.open("xb") as file:
            created=True
            file.write(token)
            file.flush()
            os.fsync(file.fileno())
        usb_store(history,key,secret,token)
    except BaseException:
        if created:
            try: path.unlink()
            except OSError: pass
        raise
