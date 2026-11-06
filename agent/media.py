"""Now-playing info and transport controls via Windows media sessions (GSMTC).

Works with Spotify, browsers, and any app that shows up in the Windows
volume / media flyout.
"""
import base64
import io
import logging
import time

log = logging.getLogger("media")

try:
    from winrt.windows.media.control import (
        GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    )
    import winrt.windows.storage.streams as streams
except ImportError:  # pragma: no cover
    SessionManager = None

# GlobalSystemMediaTransportControlsSessionPlaybackStatus values
STATUS = {0: "closed", 1: "opened", 2: "changing", 3: "stopped", 4: "playing", 5: "paused"}

ART_SIZE = 32  # downscale album art to this many pixels for the 8-bit look


def _app_name(aumid: str) -> str:
    """Readable app name from a media session's AppUserModelID.

    Packaged apps look like "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify";
    desktop apps usually give an exe name or path like "Spotify.exe".
    """
    if not aumid:
        return ""
    if "!" in aumid:
        family, app_id = aumid.split("!", 1)
        if app_id and app_id.lower() not in ("app", "application"):
            return app_id.split(".")[-1]
        return family.rsplit("_", 1)[0].split(".")[-1]
    name = aumid.replace("/", "\\").split("\\")[-1]
    if name.lower().endswith(".exe"):
        return name[:-4]
    if name.count(".") >= 2:  # reverse-DNS id, e.g. "com.github.th-ch.youtube-music"
        name = name.split(".")[-1].replace("-", " ").replace("_", " ")
    return name


def _pixelate(raw: bytes) -> str | None:
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        w, h = img.size
        s = min(w, h)
        img = img.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
        img = img.resize((ART_SIZE, ART_SIZE), Image.Resampling.BOX)
        img = img.quantize(colors=24, method=Image.Quantize.MEDIANCUT).convert("RGB")
        out = io.BytesIO()
        img.save(out, format="PNG")
        return "data:image/png;base64," + base64.b64encode(out.getvalue()).decode()
    except Exception as e:
        log.debug("art decode failed: %s", e)
        return None


async def _read_thumbnail(ref) -> bytes | None:
    stream = await ref.open_read_async()
    size = int(stream.size)
    if size <= 0 or size > 8_000_000:
        return None
    buf = streams.Buffer(size)
    res = await stream.read_async(buf, size, streams.InputStreamOptions.READ_AHEAD)
    try:
        return bytes(res)
    except TypeError:
        reader = streams.DataReader.from_buffer(res)
        arr = bytearray(res.length)
        reader.read_bytes(arr)
        return bytes(arr)


class Media:
    def __init__(self):
        self.mgr = None
        self.state = None   # dict sent to the phone, or None when nothing is playing
        self.art = None     # data URL of pixelated album art
        self.art_key = None
        self._last_err = 0.0

    async def _manager(self):
        if self.mgr is None and SessionManager is not None:
            self.mgr = await SessionManager.request_async()
        return self.mgr

    async def _session(self):
        mgr = await self._manager()
        if mgr is None:
            return None
        s = mgr.get_current_session()
        if s is None:
            sessions = list(mgr.get_sessions())
            s = sessions[0] if sessions else None
        return s

    async def poll(self) -> bool:
        """Refresh state. Returns True if the album art changed."""
        try:
            s = await self._session()
            if s is None:
                self.state = None
                return False
            props = await s.try_get_media_properties_async()
            info = s.get_playback_info()
            tl = s.get_timeline_properties()
            status = STATUS.get(int(info.playback_status), "unknown")

            pos = tl.position.total_seconds() if tl.position is not None else 0.0
            end = tl.end_time.total_seconds() if tl.end_time is not None else 0.0
            # Timeline is only updated by the app every few seconds; extrapolate.
            if status == "playing" and tl.last_updated_time is not None:
                try:
                    age = time.time() - tl.last_updated_time.timestamp()
                    if 0 < age < 3600:
                        pos += age
                except Exception:
                    pass
            if end > 0:
                pos = min(pos, end)

            self.state = {
                "title": props.title or "",
                "artist": props.artist or props.album_artist or "",
                "album": props.album_title or "",
                "status": status,
                "pos": pos,
                "pos_at": time.time(),  # when pos was measured, so the page can keep lyrics in sync
                "end": end,
                "app": _app_name(s.source_app_user_model_id or ""),
            }

            key = (props.title, props.artist, props.album_title)
            if key != self.art_key:
                self.art_key = key
                self.art = None
                if props.thumbnail is not None:
                    raw = await _read_thumbnail(props.thumbnail)
                    if raw:
                        self.art = _pixelate(raw)
                return True
            return False
        except Exception as e:
            self.mgr = None
            self.state = None
            if time.monotonic() - self._last_err > 60:
                log.warning("media poll failed: %s", e)
                self._last_err = time.monotonic()
            return False

    async def command(self, action: str):
        s = await self._session()
        if s is None:
            return
        try:
            if action == "toggle":
                await s.try_toggle_play_pause_async()
            elif action == "next":
                await s.try_skip_next_async()
            elif action == "prev":
                await s.try_skip_previous_async()
        except Exception as e:
            log.warning("media command %s failed: %s", action, e)
