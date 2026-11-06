"""Prayer times from JAKIM's e-Solat service (Malaysia, free, no API key).

Fetches the next 7 days for one zone (e.g. PNG01 = Pulau Pinang) and keeps a
copy in cache/, so the times still show after a restart without internet.
"""
import asyncio
import json
import logging
from datetime import date, timedelta

import aiohttp

from . import config as C

log = logging.getLogger("solat")

API = "https://www.e-solat.gov.my/index.php"
MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}
# e-Solat field -> key sent to the page (syuruk = sunrise, when Subuh/Fajr time ends)
PRAYERS = {"fajr": "subuh", "syuruk": "syuruk", "dhuhr": "zohor", "asr": "asar", "maghrib": "maghrib", "isha": "isyak"}


def _iso(d: str) -> str:
    """'06-Nov-2026' -> '2026-11-06' (no locale-dependent parsing)."""
    day, mon, year = d.split("-")
    return date(int(year), MONTHS[mon[:3].title()], int(day)).isoformat()


class Solat:
    def __init__(self, cfg: dict):
        self.zone = str(cfg.get("prayer_zone") or "").strip().upper()
        self.days: dict[str, dict] = {}  # "2026-11-06" -> {"subuh": "05:55", ...}
        self.cache = C.ROOT / "cache" / f"solat-{self.zone}.json"
        if self.zone:
            self._load_cache()

    @property
    def state(self) -> dict | None:
        """Today's and tomorrow's times (tomorrow is needed after Isyak)."""
        if not self.zone:
            return None
        today = date.today()
        t0 = self.days.get(today.isoformat())
        if not t0:
            return {"zone": self.zone, "error": "prayer times unavailable"}
        return {"zone": self.zone, "today": t0, "tomorrow": self.days.get((today + timedelta(1)).isoformat())}

    def _days_ahead(self) -> int:
        today = date.today()
        n = 0
        while (today + timedelta(n)).isoformat() in self.days:
            n += 1
        return n

    def _load_cache(self):
        try:
            self.days = json.loads(self.cache.read_text(encoding="utf-8"))
            if any(set(PRAYERS.values()) - set(v) for v in self.days.values()):
                self.days = {}  # cached by an older version, without sunrise: fetch again
        except FileNotFoundError:
            pass
        except (ValueError, OSError) as e:
            log.warning("ignoring prayer time cache: %r", e)

    async def refresh(self):
        params = {"r": "esolatApi/takwimsolat", "period": "week", "zone": self.zone}
        timeout = aiohttp.ClientTimeout(total=20)
        async with aiohttp.ClientSession(timeout=timeout, headers={"User-Agent": "PixelDeck/1.0"}) as s:
            async with s.get(API, params=params) as r:
                r.raise_for_status()
                data = json.loads(await r.text())
        if not str(data.get("status", "")).upper().startswith("OK"):
            raise ValueError(f"e-Solat says {data.get('status')!r} for zone {self.zone}")
        keep = (date.today() - timedelta(1)).isoformat()
        days = {k: v for k, v in self.days.items() if k >= keep}  # drop old days
        for row in data.get("prayerTime") or []:
            days[_iso(row["date"])] = {name: str(row[key])[:5] for key, name in PRAYERS.items()}
        self.days = days
        self.cache.parent.mkdir(exist_ok=True)
        self.cache.write_text(json.dumps(days, indent=1), encoding="utf-8")
        log.info("prayer times for %s: %d days ahead", self.zone, self._days_ahead())

    async def loop(self):
        if not self.zone:
            return
        while True:
            # A week is fetched at a time; top it up once fewer than 3 days are left.
            if self._days_ahead() < 3:
                try:
                    await self.refresh()
                except Exception as e:
                    log.warning("prayer times refresh failed: %r", e)
                    await asyncio.sleep(300)
                    continue
            await asyncio.sleep(1800)
