"""PC controls for the phone's control page.

Volume, mic mute, app launcher, show desktop, screenshot, lock and sleep.
The phone can only ask for one of the fixed actions in `Controls.handle`;
app buttons refer to entries in config.json by index, so nothing arbitrary
can be run from the phone.
"""
import asyncio
import concurrent.futures
import ctypes
import datetime
import logging
import os
import shutil
import uuid
from ctypes import wintypes
from pathlib import Path

log = logging.getLogger("controls")

user32 = ctypes.WinDLL("user32", use_last_error=True)


# ---------------------------------------------------------------- audio --

def _com_init():
    import comtypes
    comtypes.CoInitialize()


class Audio:
    """Windows Core Audio via pycaw. Every call runs on one dedicated COM thread."""

    def __init__(self):
        self.pool = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="audio", initializer=_com_init)
        self.state = None
        self._warned = False
        self._enum = None  # IMMDeviceEnumerator, created on (and only used from) the audio thread

    def _endpoint(self, mic: bool):
        """Volume control of the default speaker or microphone, or None if there isn't one.

        No ctypes.cast() here (pycaw's helpers use it): cast() ties the original COM
        pointer into a reference cycle, so it's only freed later by Python's garbage
        collector, on whatever thread that happens to run. On a thread without COM, that
        Release() crashes the whole agent; it started happening once the music page's
        visualizer made garbage collection run more often on other threads.
        QueryInterface gives the same interface with no cycle, so every pointer is
        released right here on the audio thread.
        """
        import comtypes
        from pycaw.constants import CLSID_MMDeviceEnumerator, EDataFlow, ERole
        from pycaw.pycaw import IAudioEndpointVolume, IMMDeviceEnumerator
        if self._enum is None:
            self._enum = comtypes.CoCreateInstance(
                CLSID_MMDeviceEnumerator, IMMDeviceEnumerator, comtypes.CLSCTX_INPROC_SERVER)
        flow = EDataFlow.eCapture.value if mic else EDataFlow.eRender.value
        try:
            dev = self._enum.GetDefaultAudioEndpoint(flow, ERole.eMultimedia.value)
        except comtypes.COMError:
            return None  # no such device, e.g. no microphone plugged in
        return dev.Activate(IAudioEndpointVolume._iid_, comtypes.CLSCTX_ALL, None).QueryInterface(IAudioEndpointVolume)

    def _read(self) -> dict:
        spk = self._endpoint(False)
        try:
            mic = self._endpoint(True)
        except Exception:
            mic = None  # no microphone plugged in
        return {
            "vol": round(spk.GetMasterVolumeLevelScalar() * 100) if spk else None,
            "muted": bool(spk.GetMute()) if spk else None,
            "mic_muted": bool(mic.GetMute()) if mic else None,
        }

    def _apply(self, action: str, value) -> dict:
        spk = self._endpoint(False)
        if action in ("vol_set", "vol_step") and spk:
            cur = spk.GetMasterVolumeLevelScalar() * 100
            target = float(value) if action == "vol_set" else cur + float(value)
            target = max(0.0, min(100.0, target))
            spk.SetMasterVolumeLevelScalar(target / 100.0, None)
            if target > 0 and spk.GetMute():
                spk.SetMute(0, None)  # like the Windows slider: turning it up unmutes
        elif action == "vol_mute" and spk:
            spk.SetMute(0 if spk.GetMute() else 1, None)
        elif action == "mic_mute":
            mic = self._endpoint(True)
            if mic:
                mic.SetMute(0 if mic.GetMute() else 1, None)
        return self._read()

    async def poll(self):
        try:
            self.state = await asyncio.get_running_loop().run_in_executor(self.pool, self._read)
            self._warned = False
        except Exception as e:
            self.state = None
            if not self._warned:
                log.warning("audio read failed: %s", e)
                self._warned = True

    async def apply(self, action: str, value=None) -> dict:
        self.state = await asyncio.get_running_loop().run_in_executor(self.pool, self._apply, action, value)
        return self.state


# ----------------------------------------------------------------- apps --

def default_apps() -> list[dict]:
    """Common apps that are actually installed, up to six."""
    la = os.environ.get("LOCALAPPDATA", "")
    ad = os.environ.get("APPDATA", "")
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    candidates = [
        {"label": "Discord", "run": rf"{la}\Discord\Update.exe", "args": "--processStart Discord.exe"},
        {"label": "Steam", "run": rf"{pf86}\Steam\steam.exe"},
        {"label": "YT Music", "run": rf"{la}\Programs\youtube-music\YouTube Music.exe"},
        {"label": "Spotify", "run": rf"{ad}\Spotify\Spotify.exe"},
        {"label": "OBS", "run": rf"{pf}\obs-studio\bin\64bit\obs64.exe"},
        {"label": "Chrome", "run": rf"{pf}\Google\Chrome\Application\chrome.exe"},
        {"label": "Files", "run": "explorer.exe"},
        {"label": "Task Mgr", "run": "taskmgr.exe"},
    ]
    return [a for a in candidates if _exists(a["run"])][:6]


def _exists(target: str) -> bool:
    return Path(target).exists() if os.path.isabs(target) else shutil.which(target) is not None


def launch(app: dict):
    """Start an app the way a double-click would (ShellExecute handles UAC and URIs)."""
    if app.get("open"):
        os.startfile(app["open"])
        return
    exe = app["run"]
    cwd = os.path.dirname(exe) if os.path.isabs(exe) else None
    os.startfile(exe, "open", app.get("args", ""), cwd)


# -------------------------------------------------------------- system --

class GUID(ctypes.Structure):
    _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD), ("Data3", wintypes.WORD), ("Data4", ctypes.c_ubyte * 8)]

    def __init__(self, s: str):
        super().__init__()
        u = uuid.UUID(s)
        self.Data1, self.Data2, self.Data3 = u.fields[0], u.fields[1], u.fields[2]
        self.Data4[:] = u.bytes[8:]


FOLDERID_SCREENSHOTS = "{b7bede81-df94-4682-a7d8-57a52620b86f}"


def screenshots_dir() -> Path:
    """The Windows Screenshots folder (follows OneDrive redirection), else Pictures\\Screenshots."""
    try:
        path = ctypes.c_wchar_p()
        shell32 = ctypes.WinDLL("shell32")
        if shell32.SHGetKnownFolderPath(ctypes.byref(GUID(FOLDERID_SCREENSHOTS)), 0, None, ctypes.byref(path)) == 0:
            result = Path(path.value)
            ctypes.windll.ole32.CoTaskMemFree(path)
            return result
    except Exception:
        pass
    return Path(os.environ.get("USERPROFILE", ".")) / "Pictures" / "Screenshots"


def take_screenshot() -> Path:
    from PIL import ImageGrab
    img = ImageGrab.grab(all_screens=True)
    folder = screenshots_dir()
    folder.mkdir(parents=True, exist_ok=True)
    out = folder / f"PixelDeck {datetime.datetime.now():%Y-%m-%d %H%M%S}.png"
    img.save(out)
    return out


def show_desktop():
    VK_LWIN, VK_D, KEYUP = 0x5B, 0x44, 0x0002
    user32.keybd_event(VK_LWIN, 0, 0, 0)
    user32.keybd_event(VK_D, 0, 0, 0)
    user32.keybd_event(VK_D, 0, KEYUP, 0)
    user32.keybd_event(VK_LWIN, 0, KEYUP, 0)


def lock_pc():
    if not user32.LockWorkStation():
        raise ctypes.WinError(ctypes.get_last_error())


def sleep_pc():
    # SetSuspendState(hibernate=False, force=False, disableWakeEvents=False)
    if not ctypes.WinDLL("powrprof").SetSuspendState(False, False, False):
        raise ctypes.WinError(ctypes.get_last_error())


# ------------------------------------------------------------ dispatch --

class Controls:
    def __init__(self, cfg: dict):
        self.audio = Audio()
        self.apps = cfg.get("apps") or default_apps()
        log.info("control page apps: %s", ", ".join(a.get("label", "?") for a in self.apps))

    def app_labels(self) -> list[str]:
        return [a.get("label", "?") for a in self.apps]

    async def handle(self, action: str, value=None) -> tuple[bool, str]:
        """Run one control action. Returns (ok, short message for the phone)."""
        loop = asyncio.get_running_loop()
        try:
            if action in ("vol_set", "vol_step", "vol_mute"):
                st = await self.audio.apply(action, value)
                return True, ("MUTED" if st.get("muted") else f"VOLUME {st.get('vol')}%") if action == "vol_mute" else ""
            if action == "mic_mute":
                st = await self.audio.apply(action)
                if st.get("mic_muted") is None:
                    return False, "NO MIC FOUND"
                return True, "MIC MUTED" if st["mic_muted"] else "MIC LIVE"
            if action == "launch":
                i = int(value)
                if not 0 <= i < len(self.apps):
                    return False, "UNKNOWN APP"
                await loop.run_in_executor(None, launch, self.apps[i])
                log.info("launched %s", self.apps[i].get("label"))
                return True, f"OPENING {self.apps[i].get('label', '').upper()}"
            if action == "screenshot":
                path = await loop.run_in_executor(None, take_screenshot)
                log.info("screenshot saved: %s", path)
                return True, "SCREENSHOT SAVED"
            if action == "desktop":
                show_desktop()
                return True, "DESKTOP"
            if action == "lock":
                log.info("locking PC (requested from phone)")
                lock_pc()
                return True, "LOCKED"
            if action == "sleep":
                log.info("sleeping PC (requested from phone)")
                loop.call_later(0.5, sleep_pc)  # let the reply reach the phone first
                return True, "SLEEPING"
        except Exception as e:
            log.warning("control %s failed: %s", action, e)
            return False, "FAILED"
        return False, "UNKNOWN ACTION"
