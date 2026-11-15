
"""USB and administrator authorization for the proposed connection gate."""
import hashlib
import hmac
import json
import os
import secrets
from pathlib import Path
from quantos_hello import dpapi
from quantos_usb import USB_FILENAME, removable_drives, token_matches, existing_usb_key, usb_load, usb_store

FOLDER=Path(os.environ["LOCALAPPDATA"])/"QuantOS"
ADMIN=FOLDER/"usb-admin.json"
BOUND=FOLDER/"desktop-usb.dpapi"
ENROLLMENT=FOLDER/"desktop-enrollment.dpapi"
HISTORY=FOLDER/"binance-history.dpapi"
MAGIC=b"QuantOS-Desktop-v1\x00"
ROUNDS=600_000

def atomic(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix(".tmp")
    temporary.write_bytes(data)
    temporary.replace(path)

def admin_matches(value):
    if not isinstance(value,str) or not 10<=len(value)<=128:
        return False
    try:
        stored=json.loads(ADMIN.read_text("utf8"))
        salt=bytes.fromhex(stored["salt"])
        expected=bytes.fromhex(stored["digest"])
        if len(salt)!=16 or len(expected)!=32: return False
        actual=hashlib.pbkdf2_hmac("sha256",value.encode(),salt,ROUNDS)
        return hmac.compare_digest(expected,actual)
    except (OSError,ValueError,KeyError,TypeError):
        return False

def bound_usb():
    try:
        with BOUND.open("rb") as source:
            data=source.read(len(MAGIC)+32)
        if not data.startswith(MAGIC) or len(data)!=len(MAGIC)+32:
            return None
        for root in removable_drives():
            key=token_matches(root,data[len(MAGIC):])
            if key is not None:
                return key
    except OSError:
        pass
    return None

def pairing_token(key):
    encrypted=BOUND.read_bytes()
    prefix=MAGIC+hashlib.sha256(key).digest()
    if not hmac.compare_digest(encrypted[:len(prefix)],prefix):
        raise ValueError("USB does not match")
    return dpapi(encrypted[len(prefix):],False,key).decode("ascii")

class PreviousUsbMissing(ValueError):
    pass

def register(root, replace_missing_history=False):
    if BOUND.exists():
        raise FileExistsError("A USB is already registered")
    if root not in removable_drives():
        raise OSError("USB not present")
    token=dpapi(ENROLLMENT.read_bytes(),False).decode("ascii")
    old_required,old_key=existing_usb_key(HISTORY) if HISTORY.is_file() else (False,None)
    target=root/USB_FILENAME
    key=secrets.token_bytes(32)
    archive_history=old_required and old_key is None
    if archive_history and not replace_missing_history:
        raise PreviousUsbMissing()
    if old_required and old_key is not None:
        key=old_key
        if token_matches(root,hashlib.sha256(key).digest()) is None:
            raise ValueError("Select the USB already protecting saved credentials")
    encrypted=MAGIC+hashlib.sha256(key).digest()+dpapi(token.encode("ascii"),True,key)
    created=False
    backup=None
    history_rewritten=False
    try:
        if not old_required or archive_history:
            with target.open("xb") as output:
                created=True
                output.write(key)
                output.flush()
                os.fsync(output.fileno())
        if archive_history:
            backup=HISTORY.with_name("binance-history-previous-"+secrets.token_hex(6)+".dpapi")
            HISTORY.rename(backup)
        elif HISTORY.is_file() and not old_required:
            credentials=usb_load(HISTORY,None)
            usb_store(HISTORY,*credentials,key)
            history_rewritten=True
        atomic(BOUND,encrypted)
        try: ENROLLMENT.unlink()
        except OSError: pass
    except BaseException:
        if backup is not None and backup.exists() and not BOUND.exists():
            backup.rename(HISTORY)
        if created and not history_rewritten and not BOUND.exists():
            try: target.unlink()
            except OSError: pass
        raise
