"""Time-synced lyrics for whatever is playing, from LRCLIB (lrclib.net: free, no account).

Results are cached in cache/lyrics/, so each song is looked up once. Songs with
no lyrics are looked up again after a week, in case someone has added them.
"""
import asyncio
import hashlib
import json
import logging
import re
import time

import aiohttp

from . import config as C

log = logging.getLogger("lyrics")

API = "https://lrclib.net/api/"
HEADERS = {"User-Agent": "MiniScreen/1.0 (personal desk dashboard)"}
RETRY_MISSING = 7 * 86400   # seconds before a "no lyrics" result is looked up again
DURATION_SLACK = 8          # seconds a version's length may differ from what's playing

_TS = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")
_QUOTED = re.compile(r"[『「](.+?)[』」]")
_BRACKETS = re.compile(r"[【\[(（][^】\])）]*[】\])）]")
_VIDEO_WORDS = re.compile(r"\b(official\s+)?(music\s+video|lyric\s+video|lyrics?|mv|m/v|audio|video|visualizer)\b", re.I)


def clean_artist(artist: str) -> str:
    """'BLUE ENCOUNT - Topic' / 'BLUEENCOUNTVEVO' / 'X Official' -> the artist's name."""
    a = re.sub(r"\s*-\s*topic$", "", artist.strip(), flags=re.I)
    a = re.sub(r"\s*(official( channel)?|vevo)$", "", a, flags=re.I)
    return a.strip()


def clean_title(title: str, artist: str) -> str:
    """Song name from a video-style title.

    'BLUE ENCOUNT 『ポラリス』Music Video【アニメ…】' -> 'ポラリス'
    'Artist - Song (Official Video)'             -> 'Song'
    """
    m = _QUOTED.search(title)
    if m:
        return m.group(1).strip()
    t = _BRACKETS.sub(" ", title)
    t = _VIDEO_WORDS.sub(" ", t)
    if " - " in t:
        left, right = (s.strip() for s in t.split(" - ", 1))
        if artist and left.lower() == artist.lower():
            t = right
        elif artist and right.lower() == artist.lower():
            t = left
    return " ".join(t.split()).strip(" -|/") or title.strip()


def parse_lrc(text: str) -> list[list]:
    """'[01:02.34] words' lines -> [[62.34, 'words'], ...] sorted by time."""
    out = []
    for raw in text.splitlines():
        stamps = _TS.findall(raw)
        if not stamps:
            continue
        words = _TS.sub("", raw).strip()
        for m, s in stamps:
            out.append([round(int(m) * 60 + float(s), 2), words])
    out.sort(key=lambda x: x[0])
    return out


def _pick(results: list, duration: float) -> dict | None:
    """The best search result: has synced lyrics, and its length matches what's playing."""
    synced = [r for r in results or [] if r.get("syncedLyrics") or r.get("instrumental")]
    if not synced:
        return None
    if not duration:
        return synced[0]
    best = min(synced, key=lambda r: abs((r.get("duration") or 0) - duration))
    return best if abs((best.get("duration") or 0) - duration) <= DURATION_SLACK else None


class Lyrics:
    def __init__(self):
        self.key = None  # (artist, title) of the song the message is about
        self.msg = {"t": "lyrics", "status": "idle", "lines": []}
        self.dir = C.ROOT / "cache" / "lyrics"

    @staticmethod
    def key_of(media: dict | None):
        if not media or not media.get("title"):
            return None
        return (media.get("artist") or "", media["title"])

    def start(self, key):
        self.key = key
        status = "searching" if key else "idle"
        artist = clean_artist(key[0]) if key else ""
        self.msg = {
            "t": "lyrics", "status": status, "lines": [],
            "title": clean_title(key[1], artist) if key else "",  # tidy name for the music page
            "artist": artist,
        }

    def _cache_file(self, key):
        return self.dir / (hashlib.sha1("|".join(key).encode()).hexdigest()[:16] + ".json")

    async def fetch(self, media: dict):
        key = self.key_of(media)
        f = self._cache_file(key)
        try:
            cached = json.loads(f.read_text(encoding="utf-8"))
            if cached["status"] != "none" or time.time() - cached.get("at", 0) < RETRY_MISSING:
                self.msg.update(status=cached["status"], lines=cached["lines"])
                return
        except (OSError, ValueError, KeyError):
            pass
        try:
            found = await self._lookup(key[0], key[1], media.get("end") or 0)
        except Exception as e:  # network trouble: say so, try again on the next song change
            log.warning("lyrics lookup failed: %r", e)
            self.msg.update(status="error", lines=[])
            return
        if found is None:
            status, lines = "none", []
        elif found.get("instrumental"):
            status, lines = "instrumental", []
        elif found.get("syncedLyrics"):
            status, lines = "ok", parse_lrc(found["syncedLyrics"])
        else:
            status, lines = "unsynced", []
        log.info("lyrics for %s - %s: %s (%d lines)", key[0], key[1][:40], status, len(lines))
        self.msg.update(status=status, lines=lines)
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps({"status": status, "lines": lines, "at": time.time()}, ensure_ascii=False), encoding="utf-8")
        except OSError as e:
            log.warning("could not cache lyrics: %r", e)

    async def _lookup(self, artist: str, title: str, duration: float) -> dict | None:
        a = clean_artist(artist)
        t = clean_title(title, a)
        timeout = aiohttp.ClientTimeout(total=20)
        async with aiohttp.ClientSession(timeout=timeout, headers=HEADERS) as s:
            # 1. Exact match (LRCLIB also checks outside sources for this one)
            for name in dict.fromkeys([t, title.strip()]):
                q = {"artist_name": a, "track_name": name}
                if duration:
                    q["duration"] = round(duration)
                found = await self._get(s, "get", q)
                if found and (found.get("syncedLyrics") or found.get("instrumental")):
                    return found
            # 2. Search, keeping the version whose length matches
            for q in ({"track_name": t, "artist_name": a}, {"q": f"{a} {t}"}):
                found = _pick(await self._get(s, "search", q), duration)
                if found:
                    return found
        return None

    @staticmethod
    async def _get(s: aiohttp.ClientSession, path: str, params: dict):
        async with s.get(API + path, params=params) as r:
            if r.status == 404:
                return None
            r.raise_for_status()
            return await r.json()
