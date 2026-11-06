"""Weather from Open-Meteo (free, no API key)."""
import logging
import time

import aiohttp

log = logging.getLogger("weather")

GEOCODE = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST = "https://api.open-meteo.com/v1/forecast"
AIR = "https://air-quality-api.open-meteo.com/v1/air-quality"

# WMO weather codes -> (label, icon name used by the web page)
CODES = {
    0: ("clear", "sun"),
    1: ("mostly clear", "partly"),
    2: ("partly cloudy", "partly"),
    3: ("overcast", "cloud"),
    45: ("fog", "fog"), 48: ("fog", "fog"),
    51: ("drizzle", "drizzle"), 53: ("drizzle", "drizzle"), 55: ("drizzle", "drizzle"),
    56: ("icy drizzle", "drizzle"), 57: ("icy drizzle", "drizzle"),
    61: ("light rain", "rain"), 63: ("rain", "rain"), 65: ("heavy rain", "rain"),
    66: ("icy rain", "rain"), 67: ("icy rain", "rain"),
    71: ("light snow", "snow"), 73: ("snow", "snow"), 75: ("heavy snow", "snow"), 77: ("snow", "snow"),
    80: ("showers", "rain"), 81: ("showers", "rain"), 82: ("heavy showers", "rain"),
    85: ("snow showers", "snow"), 86: ("snow showers", "snow"),
    95: ("storm", "storm"), 96: ("storm", "storm"), 99: ("storm", "storm"),  # thunderstorm; short to fit the big clock
}

# Rain alert, from Open-Meteo's 15-minute forecast
RAIN_MM = 0.2          # mm in 15 min that counts as rain (light drizzle is less)
HEAVY_MM = 2.0         # mm in 15 min (about 8 mm/h) that counts as heavy rain
ALERT_AHEAD = 2 * 3600  # warn about rain up to this many seconds ahead
SLOT = 900             # seconds per forecast step


def _wet(mm, code) -> bool:
    # WMO 61+ = rain, showers, thunderstorm (51-57 drizzle doesn't count)
    return (mm or 0) >= RAIN_MM or (code or 0) >= 61


def rain_alert(now: float, cur: dict, m15: dict) -> dict | None:
    """What the weather card should warn about, or None.

    {"kind": "soon", "at": t}       rain expected to start around unix time t
    {"kind": "now", "until": t}     raining now, dry again around t (None = not within 3 h)
    Both also carry "storm" (thunderstorm) and "heavy" for the first hour of that rain.
    """
    slots = [
        (t, mm or 0, code or 0)
        for t, mm, code in zip(m15.get("time") or [], m15.get("precipitation") or [], m15.get("weather_code") or [])
        if t + SLOT > now  # drop steps that are already over
    ]

    def strength(i):
        first_hour = slots[i:i + 4] or [(0, cur.get("precipitation") or 0, cur.get("weather_code") or 0)]
        return {"storm": any(c >= 95 for _, _, c in first_hour), "heavy": max(m for _, m, _ in first_hour) >= HEAVY_MM}

    if _wet(cur.get("precipitation"), cur.get("weather_code")):
        until = next((t for t, m, c in slots if not _wet(m, c)), None)
        return {"kind": "now", "until": until, **strength(0)}
    for i, (t, m, c) in enumerate(slots):
        if t - now > ALERT_AHEAD:
            break
        if _wet(m, c):
            return {"kind": "soon", "at": t, **strength(i)}
    return None


class Weather:
    def __init__(self, cfg: dict):
        self.city = (cfg.get("city") or "").strip()
        self.lat = cfg.get("latitude")
        self.lon = cfg.get("longitude")
        self.place = self.city
        self.state = None
        self._last_alert = None

    @property
    def configured(self) -> bool:
        return bool(self.city) or (self.lat is not None and self.lon is not None)

    async def _geocode(self, session: aiohttp.ClientSession):
        async with session.get(GEOCODE, params={"name": self.city, "count": 1, "format": "json"}) as r:
            r.raise_for_status()
            data = await r.json()
        res = (data.get("results") or [None])[0]
        if not res:
            raise ValueError(f"city not found: {self.city}")
        self.lat, self.lon = res["latitude"], res["longitude"]
        self.place = res.get("name", self.city)
        log.info("weather location: %s, %s (%.3f, %.3f)", self.place, res.get("country", ""), self.lat, self.lon)

    async def _air(self, session: aiohttp.ClientSession) -> dict:
        """Current air quality (Open-Meteo / CAMS). A failure here leaves the weather alone."""
        params = {"latitude": self.lat, "longitude": self.lon, "current": "us_aqi,pm2_5", "timezone": "auto"}
        try:
            async with session.get(AIR, params=params) as r:
                r.raise_for_status()
                return (await r.json()).get("current") or {}
        except Exception as e:
            log.warning("air quality refresh failed: %r", e)
            return {}

    async def refresh(self) -> bool:
        if not self.configured:
            self.state = {"error": "set city in config.json"}
            return False
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            if self.lat is None or self.lon is None:
                await self._geocode(session)
            params = {
                "latitude": self.lat,
                "longitude": self.lon,
                "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m,precipitation,uv_index",
                "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
                "minutely_15": "precipitation,weather_code",
                "forecast_minutely_15": 12,  # the next 3 hours
                "forecast_days": 1,
                "timezone": "auto",
                "timeformat": "unixtime",
            }
            async with session.get(FORECAST, params=params) as r:
                r.raise_for_status()
                d = await r.json()
            air = await self._air(session)
        cur = d["current"]
        day = d["daily"]
        code = int(cur.get("weather_code", 0))
        label, icon = CODES.get(code, ("unknown", "cloud"))
        if not cur.get("is_day", 1) and icon in ("sun", "partly"):
            icon = "moon"
        self.state = {
            "place": self.place,
            "temp": cur.get("temperature_2m"),
            "feels": cur.get("apparent_temperature"),
            "humidity": cur.get("relative_humidity_2m"),
            "wind": cur.get("wind_speed_10m"),
            "label": label,
            "icon": icon,
            "hi": (day.get("temperature_2m_max") or [None])[0],
            "lo": (day.get("temperature_2m_min") or [None])[0],
            "rain": (day.get("precipitation_probability_max") or [None])[0],
            "alert": rain_alert(time.time(), cur, d.get("minutely_15") or {}),
            "uv": cur.get("uv_index"),
            "aqi": air.get("us_aqi"),    # US AQI: 0-50 good, 51-100 moderate, 101-150 unhealthy for sensitive groups, 151+ unhealthy
            "pm25": air.get("pm2_5"),
        }
        if self.state["alert"] != self._last_alert:
            log.info("rain alert: %s", self.state["alert"])
            self._last_alert = self.state["alert"]
        return True
