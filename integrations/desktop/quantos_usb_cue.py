
"""Pixel-art cue for Windows removable-drive insertion."""
import time
import tkinter as tk

from quantos_usb import removable_drives

BACKGROUND="#101c27"
PIXELS=(
    "....####....",
    "....ssss....",
    "....shhs....",
    "....ssss....",
    "...######...",
    "..#gggggg#..",
    "..#gllllg#..",
    "..#glwwlg#..",
    "..#gllllg#..",
    "..#gggggg#..",
    "..#ggddgg#..",
    "...######...",
)
PALETTE={"#":"#162d3c","s":"#a6c1d1","h":"#587888","g":"#55ba9e",
         "l":"#317a73","w":"#d8fff1","d":"#2a625d"}

class UsbCue(tk.Canvas):
    def __init__(self,parent,find_drives=removable_drives,clock=time.monotonic):
        super().__init__(parent,width=168,height=66,background=BACKGROUND,highlightthickness=0)
        self.find_drives=find_drives
        self.clock=clock
        self.drives=set(find_drives())
        self.drive=self.first(self.drives)
        self.started=None
        self.frame=None
        self.draw(1 if self.drive else 0)
        self.poll_timer=self.after(400,self.poll)

    @staticmethod
    def first(drives):
        return min(drives,key=str) if drives else None

    def poll(self):
        drives=set(self.find_drives())
        inserted=drives-self.drives
        self.drives=drives
        if inserted:
            self.drive=self.first(inserted)
            self.started=self.clock()
            if self.frame is not None:
                self.after_cancel(self.frame)
            self.tick()
        elif self.drive not in drives:
            if self.frame is not None:
                self.after_cancel(self.frame)
                self.frame=None
            self.drive=self.first(drives)
            self.started=None
            self.draw(1 if self.drive else 0)
        self.poll_timer=self.after(400,self.poll)

    def tick(self):
        progress=min(1,(self.clock()-self.started)/0.7)
        self.draw(progress,pulse=progress>0.8)
        self.frame=self.after(16,self.tick) if progress<1 else None

    def draw(self,progress,pulse=False):
        self.delete("all")
        # The socket covers the plug tip as it slides upward.
        self.create_rectangle(0,0,167,65,fill="#142532",outline="#2b4758")
        if self.drive is not None:
            eased=1-(1-progress)**3
            offset=round(76-65*eased)
            for row,line in enumerate(PIXELS):
                for col,code in enumerate(line):
                    if code==".": continue
                    x,y=8+3*col,offset+3*row
                    self.create_rectangle(x,y,x+2,y+2,fill=PALETTE[code],outline="",tags=("usb",))
        self.create_rectangle(11,6,43,16,fill="#203e4c",outline="#3d6274")
        self.create_rectangle(17,10,37,13,fill="#0c1a23",outline="")
        self.create_rectangle(13,18,15,20,fill="#98f2d8" if pulse else "#508278",outline="")
        self.create_rectangle(39,18,41,20,fill="#98f2d8" if pulse else "#508278",outline="")
        label="检测到 U 盘" if self.drive is not None else "等待 U 盘"
        self.create_text(54,23,text=label,anchor="w",
                         fill="#b2f7e3" if self.drive else "#aac4ce",font=("Microsoft YaHei UI",10,"bold"))
        hint=self.drive.drive if self.drive is not None else "USB"
        self.create_text(54,43,text=hint,anchor="w",fill="#8eafba",font=("Consolas",9))
