"""Loads config.json from the project root, filling in defaults."""
import json
import logging
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"
WEB_DIR = ROOT / "web"
LOG_DIR = ROOT / "logs"

DEFAULTS = {
    "port": 8765,
    "city": "",
    "latitude": None,
    "longitude": None,
    "clock_24h": True,
    "layout": "bigclock",
    "phone_serial": "",
    "phone_app_package": "",
    "adb_path": "",
    "night_dim": {"start": "00:00", "end": "07:00", "level": 0.6},
    "idle_dim_minutes": 10,
    "pixel_shift_minutes": 3,
    "ping": {"hosts": ["1.1.1.1", "8.8.8.8"], "warn_ms": 100},
    "prayer_zone": "",
    "calendar": {"ics": [], "days_ahead": 7, "remind_minutes": 5, "holiday_region": ""},
    "haptics": True,
}

log = logging.getLogger("config")


def load() -> dict:
    cfg = json.loads(json.dumps(DEFAULTS))
    try:
        # utf-8-sig also accepts a byte-order mark, which Notepad and
        # Windows PowerShell 5.1 often add when saving.
        user = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    except FileNotFoundError:
        log.warning("config.json not found, using defaults")
    except json.JSONDecodeError as e:
        log.error("config.json is not valid JSON (%s), using defaults", e)
    return cfg
