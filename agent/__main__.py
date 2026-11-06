"""PixelDeck agent: collects PC stats and streams them to the phone.

Run with:  .venv\\Scripts\\python.exe -m agent
"""
import asyncio
import json
import logging
import mimetypes
import sys
import time
from logging.handlers import RotatingFileHandler

from aiohttp import WSMsgType, web

from . import config as C
from . import winstate
from .adb import Adb
from .calendar_feed import CalendarFeed
from .controls import Controls
from .lhm import LhmReader
from .lyrics import Lyrics
from .media import Media
from .ping import Ping
from .solat import Solat
from .stats import Stats
from .visualizer import Visualizer
from .weather import Weather

log = logging.getLogger("agent")

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("text/javascript", ".js")


def setup_logging():
    C.LOG_DIR.mkdir(exist_ok=True)
    handlers = [RotatingFileHandler(C.LOG_DIR / "agent.log", maxBytes=1_000_000, backupCount=2, encoding="utf-8")]
    if sys.stdout is not None:  # pythonw.exe has no console
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)-7s %(levelname)-5s %(message)s",
        handlers=handlers,
    )
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)


class Hub:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.clients: set[web.WebSocketResponse] = set()
        self.stats = Stats()
        self.lhm = LhmReader()
        self.media = Media()
        self.weather = Weather(cfg)
        self.ping = Ping(cfg)
        self.solat = Solat(cfg)
        self.calendar = CalendarFeed(cfg)
        self.lyrics = Lyrics()
        self.viz = Visualizer()
        self.pages: dict[web.WebSocketResponse, str] = {}  # which page each screen is showing
        self.adb = Adb(cfg)
        self.controls = Controls(cfg)
        self.last = None
        port = int(cfg["port"])
        # Browsers send an Origin header; only the PixelDeck page itself may connect.
        # Without this, any website open on the PC could reach ws://127.0.0.1:PORT.
        self.allowed_origins = {f"http://localhost:{port}", f"http://127.0.0.1:{port}"}
        self._ver = ""
        self._ver_t = 0.0
        self._pending = ""
        self._pending_t = 0.0

    def web_version(self) -> str:
        """Changes whenever a file in web/ changes, so open screens reload themselves.

        A new version is only published once web/ has been unchanged for 5 s, so a
        screen never reloads into a half-saved update (new HTML with an old script).
        """
        now = time.monotonic()
        if now - self._ver_t < 1:
            return self._ver
        self._ver_t = now
        try:
            newest = format(max(p.stat().st_mtime_ns for p in C.WEB_DIR.rglob("*") if p.is_file()), "x")
        except ValueError:
            newest = ""
        if not self._ver:
            self._ver = self._pending = newest  # first call: publish immediately
        elif newest != self._pending:
            self._pending, self._pending_t = newest, now
        elif newest != self._ver and now - self._pending_t >= 5:
            self._ver = newest
        return self._ver

    def ui_config(self) -> dict:
        keys = ("clock_24h", "layout", "night_dim", "idle_dim_minutes", "pixel_shift_minutes", "haptics")
        out = {k: self.cfg[k] for k in keys}
        out["apps"] = self.controls.app_labels()
        return out

    async def send_all(self, msg: dict):
        if not self.clients:
            return
        data = json.dumps(msg, separators=(",", ":"))
        for ws in list(self.clients):
            try:
                await ws.send_str(data)
            except Exception:
                self.clients.discard(ws)

    def snapshot(self) -> dict:
        s = self.stats.sample()
        lhm = self.lhm.data or {}
        s["cpu"].update({"temp": lhm.get("temp"), "power": lhm.get("power"), "clock": lhm.get("clock")})
        s.update({
            "t": "stats",
            "v": self.web_version(),
            "time": time.time(),
            "media": self.media.state,
            "audio": self.controls.audio.state,
            "weather": self.weather.state,
            "ping": self.ping.state,
            "solat": self.solat.state,
            "calendar": self.calendar.state,
            "phone": self.adb.phone,
            "locked": winstate.is_locked(),
            "idle": round(winstate.idle_seconds()),
            "lhm": self.lhm.available,
        })
        return s

    def art_msg(self) -> dict:
        return {"t": "art", "data": self.media.art}

    # ---- loops -------------------------------------------------------------

    async def stats_loop(self):
        while True:
            t0 = time.monotonic()
            try:
                self.last = self.snapshot()
                await self.send_all(self.last)
            except Exception:
                log.exception("stats loop")
            await asyncio.sleep(max(0.2, 1.0 - (time.monotonic() - t0)))

    async def media_loop(self):
        while True:
            if await self.media.poll():
                await self.send_all(self.art_msg())
            await asyncio.sleep(1.0)

    async def audio_loop(self):
        while True:
            await self.controls.audio.poll()
            await asyncio.sleep(1.0)

    async def lyrics_loop(self):
        """Look up lyrics whenever the song changes, and tell the screens."""
        while True:
            m = self.media.state
            key = Lyrics.key_of(m)
            if key != self.lyrics.key:
                self.lyrics.start(key)
                await self.send_all(self.lyrics.msg)
                if key:
                    await self.lyrics.fetch(m)
                    await self.send_all(self.lyrics.msg)
            await asyncio.sleep(1.0)

    async def viz_loop(self):
        """~30 visualizer frames a second, only to screens on the music page."""
        sent = -1
        while True:
            viewers = [ws for ws, page in self.pages.items() if page == "music"]
            self.viz.set_active(bool(viewers))
            if viewers and self.viz.seq != sent:
                sent = self.viz.seq
                data = json.dumps({"t": "viz", "b": self.viz.levels}, separators=(",", ":"))
                for ws in viewers:
                    try:
                        await ws.send_str(data)
                    except Exception:
                        self.pages.pop(ws, None)
            await asyncio.sleep(1 / 30)

    async def weather_loop(self):
        while True:
            try:
                ok = await self.weather.refresh()
                await asyncio.sleep(10 * 60 if ok else 30)  # 10 min keeps the rain alert fresh
            except Exception as e:
                log.warning("weather refresh failed: %r", e)
                self.weather.state = {"error": "weather offline"}
                await asyncio.sleep(120)

    # ---- http --------------------------------------------------------------

    async def ws_handler(self, request: web.Request):
        origin = request.headers.get("Origin")
        if origin and origin not in self.allowed_origins:
            log.warning("refused connection from origin %s", origin)
            raise web.HTTPForbidden()
        ws = web.WebSocketResponse(heartbeat=15)
        await ws.prepare(request)
        self.clients.add(ws)
        log.info("screen connected (%d open)", len(self.clients))
        await ws.send_json({"t": "hello", "config": self.ui_config()})
        await ws.send_json(self.art_msg())
        await ws.send_json(self.lyrics.msg)
        if self.last:
            await ws.send_json(self.last)
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    m = json.loads(msg.data)
                except ValueError:
                    continue
                if m.get("cmd") == "media" and m.get("action") in ("toggle", "next", "prev"):
                    await self.media.command(m["action"])
                    await asyncio.sleep(0.3)
                    if await self.media.poll():
                        await self.send_all(self.art_msg())
                elif m.get("cmd") == "page" and isinstance(m.get("page"), str):
                    self.pages[ws] = m["page"][:20]
                elif m.get("cmd") == "control" and isinstance(m.get("action"), str):
                    ok, text = await self.controls.handle(m["action"], m.get("value"))
                    await ws.send_json({"t": "ack", "ok": ok, "msg": text, "audio": self.controls.audio.state})
        finally:
            self.clients.discard(ws)
            self.pages.pop(ws, None)
            log.info("screen disconnected (%d open)", len(self.clients))
        return ws

    async def state_handler(self, request: web.Request):
        return web.json_response(self.last or {})

    async def static_handler(self, request: web.Request):
        rel = request.match_info.get("path") or "index.html"
        target = (C.WEB_DIR / rel).resolve()
        if C.WEB_DIR.resolve() not in target.parents and target != C.WEB_DIR.resolve():
            raise web.HTTPNotFound()
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            raise web.HTTPNotFound()
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        return web.FileResponse(target, headers={"Cache-Control": "no-cache", "Content-Type": ctype})


async def main():
    setup_logging()
    cfg = C.load()
    hub = Hub(cfg)

    app = web.Application()
    app.router.add_get("/ws", hub.ws_handler)
    app.router.add_get("/api/state", hub.state_handler)
    app.router.add_get("/{path:.*}", hub.static_handler)

    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", int(cfg["port"]))
    try:
        await site.start()
    except OSError as e:
        log.error("port %s busy (agent already running?): %s", cfg["port"], e)
        return
    log.info("serving on http://127.0.0.1:%s", cfg["port"])

    hub.lhm.start()
    await asyncio.gather(
        hub.stats_loop(), hub.media_loop(), hub.audio_loop(), hub.weather_loop(),
        hub.ping.loop(), hub.solat.loop(), hub.calendar.loop(), hub.adb.loop(),
        hub.lyrics_loop(), hub.viz_loop(),
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
