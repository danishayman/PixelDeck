"""Upcoming events from iCal (.ics) feeds, such as Google Calendar's secret address.

No login is needed: the secret iCal address is a private, read-only link. It is
kept in config.json and never written to the log. Repeating events, time zones,
moved or cancelled occurrences are handled by the recurring-ical-events library.
"""
import asyncio
import logging
import re
import time
from datetime import datetime, timedelta

import aiohttp
import icalendar
import recurring_ical_events

log = logging.getLogger("calendar")

REFRESH = 5 * 60    # seconds between downloads, so a newly added event shows within ~5 min
MAX_EVENTS = 8      # events sent to the page (it picks which one to show)


def _ts(v) -> float:
    """date or datetime -> unix seconds. Dates and times without a zone are local."""
    if isinstance(v, datetime):
        return v.timestamp()  # naive datetimes are taken as local time
    return datetime(v.year, v.month, v.day).timestamp()


def _declined(ev, me: str) -> bool:
    """True if the calendar's owner declined this event (Google names the calendar after their email)."""
    if "@" not in me:
        return False
    attendees = ev.get("ATTENDEE") or []
    if not isinstance(attendees, list):
        attendees = [attendees]
    for a in attendees:
        if str(a).lower().removeprefix("mailto:") == me:
            return str(a.params.get("PARTSTAT", "")).upper() == "DECLINED"
    return False


def _not_a_day_off(ev, region: str) -> bool:
    """For Google's public-holiday calendars, which say in DESCRIPTION what each day is:
    skip observances (Valentine's Day, Christmas Eve...) and other states' holidays."""
    desc = str(ev.get("DESCRIPTION", "")).strip()
    if desc.startswith("Observance"):
        return True
    prefix = "Public holiday in "
    if region and desc.startswith(prefix):
        states = [s.strip().lower() for s in desc.splitlines()[0][len(prefix):].split(",")]
        return region.lower() not in states
    return False


def upcoming(ics: bytes, now: float, days_ahead: int, region: str = "") -> list[dict]:
    """Events that haven't ended yet and start within days_ahead days, soonest first.
    region (e.g. "Penang") keeps only that state's holidays from a holiday calendar."""
    cal = icalendar.Calendar.from_ical(ics)
    me = str(cal.get("X-WR-CALNAME", "")).strip().lower()
    t0 = datetime.fromtimestamp(now) - timedelta(days=1)  # catches long events already under way
    t1 = datetime.fromtimestamp(now) + timedelta(days=days_ahead)
    out = []
    for ev in recurring_ical_events.of(cal).between(t0, t1):
        if str(ev.get("STATUS", "")).upper() == "CANCELLED" or _declined(ev, me) or _not_a_day_off(ev, region):
            continue
        start = ev.get("DTSTART").dt
        allday = not isinstance(start, datetime)
        if ev.get("DTEND") is not None:
            end = ev.get("DTEND").dt
        elif ev.get("DURATION") is not None:
            end = start + ev.get("DURATION").dt
        else:
            end = start + timedelta(days=1) if allday else start
        s = _ts(start)
        e = max(_ts(end), s + 60)  # a zero-length event (a reminder) lasts a minute
        if e <= now:
            continue
        title = re.sub(r"\s*\(regional holiday\)", "", str(ev.get("SUMMARY", "")), flags=re.I)
        out.append({
            "title": " ".join(title.split()) or "(no title)",
            "start": s,
            "end": e,
            "allday": allday,
        })
    out.sort(key=lambda x: (x["start"], not x["allday"]))
    return out


class CalendarFeed:
    def __init__(self, cfg: dict):
        c = cfg.get("calendar") or {}
        urls = c.get("ics") or []
        self.urls = [urls] if isinstance(urls, str) else [str(u) for u in urls if u]
        self.days_ahead = int(c.get("days_ahead") or 7)
        self.remind = int(c.get("remind_minutes") or 0)
        self.region = str(c.get("holiday_region") or "").strip()
        self.state = None  # None = not configured or nothing fetched yet
        self._ics: list[bytes | None] = [None] * len(self.urls)

    async def _fetch(self, session: aiohttp.ClientSession, i: int):
        try:
            async with session.get(self.urls[i]) as r:
                if r.status != 200:
                    # The address is a secret: log which calendar, never the URL.
                    log.warning("calendar %d: HTTP %d (check the iCal address in config.json)", i + 1, r.status)
                    return
                self._ics[i] = await r.read()
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            log.warning("calendar %d unreachable: %s", i + 1, type(e).__name__)

    async def refresh(self):
        timeout = aiohttp.ClientTimeout(total=30)
        async with aiohttp.ClientSession(timeout=timeout, headers={"User-Agent": "MiniScreen/1.0"}) as s:
            await asyncio.gather(*(self._fetch(s, i) for i in range(len(self.urls))))
        events, now = [], time.time()
        for i, ics in enumerate(self._ics):
            if ics is None:  # never fetched; a failed refresh keeps the last good copy
                continue
            try:
                events += await asyncio.to_thread(upcoming, ics, now, self.days_ahead, self.region)
            except Exception as e:
                log.warning("calendar %d could not be read: %r", i + 1, e)
        events.sort(key=lambda x: (x["start"], not x["allday"]))
        if any(ics is not None for ics in self._ics):
            self.state = {"events": events[:MAX_EVENTS], "remind": self.remind}

    async def loop(self):
        if not self.urls:
            return
        first = True
        while True:
            try:
                await self.refresh()
                if first and self.state is not None:
                    log.info("calendar: %d feed(s), %d upcoming event(s)", len(self.urls), len(self.state["events"]))
                    first = False
            except Exception:
                log.exception("calendar refresh")
            await asyncio.sleep(REFRESH)
