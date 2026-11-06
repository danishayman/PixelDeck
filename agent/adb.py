"""Keeps the USB tunnel to the phone alive and reads the phone's battery.

`adb reverse tcp:PORT tcp:PORT` makes http://localhost:PORT on the phone
reach this PC over the USB cable, so no Wi-Fi or firewall rule is needed.
"""
import asyncio
import logging
import os
import re
import shutil
import subprocess
from pathlib import Path

log = logging.getLogger("adb")

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def find_adb(configured: str = "") -> str | None:
    if configured and Path(configured).exists():
        return configured
    found = shutil.which("adb")
    if found:
        return found
    for base in (os.environ.get("LOCALAPPDATA", ""), os.environ.get("ANDROID_HOME", ""), os.environ.get("ANDROID_SDK_ROOT", "")):
        if not base:
            continue
        for cand in (Path(base) / "Android" / "Sdk" / "platform-tools" / "adb.exe", Path(base) / "platform-tools" / "adb.exe"):
            if cand.exists():
                return str(cand)
    return None


class Adb:
    def __init__(self, cfg: dict):
        self.port = int(cfg["port"])
        self.serial_pref = cfg.get("phone_serial") or ""
        self.app_package = cfg.get("phone_app_package") or ""
        self.path = find_adb(cfg.get("adb_path", ""))
        self.serial = None
        self.connected = False
        self.phone = None  # {"battery": .., "temp": .., "charging": ..}
        if not self.path:
            log.error("adb.exe not found; set adb_path in config.json")

    async def run(self, *args, timeout: float = 10.0) -> tuple[int, str]:
        proc = await asyncio.create_subprocess_exec(
            self.path, *args,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            creationflags=NO_WINDOW,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            return -1, "timeout"
        return proc.returncode, out.decode(errors="replace")

    async def _pick_device(self) -> str | None:
        code, out = await self.run("devices")
        if code != 0:
            return None
        rows = [ln.split() for ln in out.splitlines()[1:] if ln.strip()]
        ready = [r[0] for r in rows if len(r) >= 2 and r[1] == "device"]
        if not ready:
            unauth = [r[0] for r in rows if len(r) >= 2 and r[1] == "unauthorized"]
            if unauth:
                log.warning("phone %s needs USB debugging approval on its screen", unauth[0])
            return None
        if self.serial_pref and self.serial_pref in ready:
            return self.serial_pref
        return ready[0]

    async def _ensure_reverse(self, serial: str) -> bool:
        rule = f"tcp:{self.port}"
        code, out = await self.run("-s", serial, "reverse", "--list")
        if code == 0 and rule in out:
            return True
        code, out = await self.run("-s", serial, "reverse", rule, rule)
        if code == 0:
            log.info("USB tunnel up: phone localhost:%s -> PC", self.port)
            return True
        log.warning("adb reverse failed: %s", out.strip())
        return False

    async def _battery(self, serial: str):
        code, out = await self.run("-s", serial, "shell", "dumpsys", "battery")
        if code != 0:
            return
        def grab(key):
            m = re.search(rf"^\s*{key}:\s*(\S+)", out, re.M)
            return m.group(1) if m else None
        try:
            level = int(grab("level") or 0)
            temp = int(grab("temperature") or 0) / 10.0
            charging = any(grab(k) == "true" for k in ("AC powered", "USB powered", "Wireless powered"))
            self.phone = {"battery": level, "temp": temp, "charging": charging}
        except ValueError:
            pass

    async def _find_webapk(self, serial: str) -> str | None:
        """Find the installed PixelDeck web app (a Chrome WebAPK whose scope is localhost)."""
        code, out = await self.run("-s", serial, "shell", "pm", "list", "packages")
        if code != 0:
            return None
        pkgs = [ln.split(":", 1)[1].strip() for ln in out.splitlines() if ln.startswith("package:") and "webapk" in ln]
        for pkg in pkgs:
            code, info = await self.run("-s", serial, "shell", "dumpsys", "package", pkg)
            if code == 0 and "localhost" in info:
                log.info("found PixelDeck web app: %s", pkg)
                return pkg
        return None

    async def launch_app(self, serial: str):
        if self.app_package.lower() == "none":
            return  # auto-launch turned off in config.json
        if not self.app_package:
            self.app_package = await self._find_webapk(serial) or ""
        if not self.app_package:
            return
        await self.run("-s", serial, "shell", "monkey", "-p", self.app_package,
                       "-c", "android.intent.category.LAUNCHER", "1")
        log.info("launched %s on phone", self.app_package)

    async def loop(self):
        if not self.path:
            return
        tick = 0
        while True:
            try:
                serial = await self._pick_device()
                if serial:
                    ok = await self._ensure_reverse(serial)
                    if ok and not self.connected:
                        log.info("phone %s connected", serial)
                        self.serial = serial
                        await self._battery(serial)
                        await self.launch_app(serial)
                    self.connected = ok
                    if tick % 12 == 0:
                        await self._battery(serial)
                    elif ok and not self.app_package and tick % 12 == 6:
                        await self.launch_app(serial)  # web app installed since connect?
                else:
                    if self.connected:
                        log.info("phone disconnected")
                    self.connected = False
                    self.phone = None
            except Exception as e:
                log.warning("adb loop error: %s", e)
            tick += 1
            await asyncio.sleep(5)
