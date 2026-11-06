<div align="center">

# PixelDeck

**Turn an old Android phone into a retro-pixel desk dashboard for your Windows PC.**

A big pixel clock, live PC stats, internet ping, weather with rain alerts, prayer times, your next calendar event,
synced lyrics with a music visualizer, and a control deck for volume, mic, apps, lock and sleep.
All of it over a USB cable, with no Wi-Fi setup and nothing exposed to your network.

![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0b0b0b?style=flat-square&labelColor=ffd23f)
![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-0b0b0b?style=flat-square&labelColor=3ddc84)
![Phone: Android + Chrome](https://img.shields.io/badge/phone-Android%20%2B%20Chrome-0b0b0b?style=flat-square&labelColor=ff5ca8)
![License: MIT](https://img.shields.io/badge/license-MIT-0b0b0b?style=flat-square&labelColor=3cd7ff)

<img src="docs/images/clock-bigclock.png" alt="PixelDeck clock page: big pixel clock, CPU, GPU, RAM and network cards, prayer times, weather and now playing" width="880">

</div>

## On the desk

<table>
  <tr>
    <td width="33%"><img src="docs/images/desk-clock.jpg" alt="PixelDeck clock page on a phone in a wooden stand"></td>
    <td width="33%"><img src="docs/images/desk-music.jpg" alt="PixelDeck music page with synced lyrics and a spectrum visualizer"></td>
    <td width="33%"><img src="docs/images/desk-controls.jpg" alt="PixelDeck control page with volume, mic, app and system buttons"></td>
  </tr>
  <tr>
    <td align="center"><b>Clock</b><br><sub>stats, prayer times, weather, now playing</sub></td>
    <td align="center"><b>Music</b><br><sub>synced lyrics and a live visualizer</sub></td>
    <td align="center"><b>Controls</b><br><sub>volume, mic, apps, lock and sleep</sub></td>
  </tr>
</table>

Swipe left or right to move between the three pages. A Redmi Note 10 in a bamboo stand is shown here, but any Android phone with Chrome works.

<table>
  <tr>
    <td width="50%"><img src="docs/images/clock-classic.png" alt="PixelDeck classic clock layout: week strip, CPU and GPU sparklines, disk activity and weather card"></td>
    <td width="50%"><img src="docs/images/controls.png" alt="PixelDeck control page: volume bar, mic toggle, six app buttons, screenshot, show desktop, clock style, lock and sleep"></td>
  </tr>
  <tr>
    <td align="center"><b>Classic clock layout</b><br><sub>the alternative to the big clock, picked on the control page</sub></td>
    <td align="center"><b>Control page</b><br><sub>LOCK and SLEEP need a 1-second hold</sub></td>
  </tr>
</table>

## Features

- **Big pixel clock** with the date, phone battery and temperature, and a seconds bar. Tap to switch 12/24 hour.
- **PC stats**: CPU (with the busiest app), NVIDIA GPU load, power and temperature, RAM, network speed and free disk space.
- **Internet status**: ping to 1.1.1.1 every 2 seconds, packet loss, and a red **OFFLINE** card with a timer when the connection drops.
- **Weather** from Open-Meteo with a 2-hour **rain alert** (`RAIN IN 20 MIN`, `DRY BY 17:15`), air quality and UV index.
- **Prayer times** from JAKIM e-Solat with the current prayer highlighted (Malaysia, optional).
- **Next calendar event** from any iCal / `.ics` link (Google Calendar works), with reminders and public holidays.
- **Now playing** for anything in the Windows media flyout (Spotify, YouTube Music, browsers…) with pixelated album art and ⏮ ⏯ ⏭.
- **Music page** with synced lyrics from LRCLIB and a 32-bar spectrum visualizer of whatever the PC is playing.
- **Control page**: PC volume and mute, mic mute, six app launchers, screenshot, show desktop, lock and sleep.
- **AMOLED care**: pure black background, pixel shifting, night and idle dimming, and a moving screensaver clock when the PC is locked or off.

## How it works

```
 Windows PC                                   Phone (USB cable)
 ┌───────────────────────────────┐            ┌─────────────────────────────┐
 │ agent (Python, runs at logon) │  adb       │ Chrome web app, fullscreen  │
 │  psutil, NVML, Windows media, │  reverse   │ http://localhost:8765       │
 │  Open-Meteo weather           │◄──────────►│ updates once a second over  │
 │  serves web/ on 127.0.0.1:8765│  tcp:8765  │ a WebSocket                 │
 └───────────────────────────────┘            └─────────────────────────────┘
```

A small Python agent on the PC collects everything and serves the web page. The phone reaches it only through the USB cable (`adb reverse`), so there's no Wi-Fi setup, no firewall rule, and nothing listening on your network: the agent binds to 127.0.0.1 only.

The page is plain HTML, CSS and JavaScript with no build step. The pixel icons are drawn in code (`web/pixels.js`).

## Requirements

- **Windows 10 or 11** with **Python 3.11+**
- **Android SDK platform-tools** (`adb`) on PATH or in the Android SDK folder
- An **Android phone** with Chrome and **USB debugging** turned on (Settings → About phone → tap *Build number* 7 times → Developer options → USB debugging)
- Optional: an **NVIDIA GPU** for the GPU card, and **LibreHardwareMonitor** for CPU temperature

## Setup

```powershell
git clone https://github.com/danishayman/PixelDeck.git
cd PixelDeck
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
copy config.example.json config.json   # then edit config.json (see Configuration)
.\scripts\install-autostart.ps1        # start the agent at every logon
.\scripts\restart-agent.ps1            # start it now
```

Then put the app on the phone:

1. Plug the phone in and unlock it. Approve the USB debugging prompt if it shows. The agent opens the USB tunnel within 5 seconds.
2. In Chrome on the phone, open `http://localhost:8765`.
3. Chrome menu (⋮) → **Add to Home screen** / **Install app** → **Install**.
4. Open the installed app (it's called **Mini Screen** on the home screen) and turn the phone sideways. It runs fullscreen and keeps the screen on.

From then on there's nothing to do day to day. The agent starts 15 s after you log in to Windows, re-opens the USB tunnel whenever the phone is plugged in, and opens the web app on the phone. It finds the installed app by itself (any Chrome web app whose address is `localhost`).

> [!NOTE]
> On MIUI (Xiaomi, Redmi, POCO), `adb shell input` taps are silently ignored unless "USB debugging (Security settings)" is on in Developer options. Nothing here needs it, which is why the install taps are done by hand.

## Using it

| Action | What it does |
| --- | --- |
| Swipe left | Clock → **music page** → control page → clock |
| Swipe right | The other way: clock → **control page** → music page → clock. The control page goes back to the clock by itself after 45 s untouched, the music page after 2 minutes with nothing playing |
| Tap the clock card | Switch between 12 and 24 hour time (remembered on the phone) |
| Hold the clock card 2 s | Reload the page |
| ⏮ ⏯ ⏭ buttons | Control whatever is playing on the PC (Spotify, YouTube Music, browser, any app in the Windows media flyout) |

### Control page

| Control | What it does |
| --- | --- |
| Volume bar | Tap or drag to set the PC's volume (5% steps). **−** / **+** step by 5%, **MUTE** toggles mute |
| MIC card | Tap to mute or unmute the default microphone in Windows. Turns red while muted |
| App buttons | Open the app on the PC. Defaults to installed ones from Discord, Steam, YT Music, Spotify, OBS, Chrome, File Explorer, Task Manager (first six found); set your own with `apps` in `config.json` |
| SHOT | Saves a screenshot of all monitors to `Pictures\Screenshots` |
| DESKTOP | Show desktop (Win+D) |
| Clock style button | Switch the clock page between **big clock** (stats on the left) and **classic** (the grid). Remembered on the phone |
| LOCK / SLEEP | **Press and hold for 1 second** (the button fills red) to lock or sleep the PC. A quick tap does nothing |

### Music page

- **Now playing** with big pixelated album art, a tidied-up title (a YouTube title like `BLUE ENCOUNT 『ポラリス』Music Video【…】` shows as `ポラリス`), progress and ⏮ ⏯ ⏭.
- **Synced lyrics** from [LRCLIB](https://lrclib.net) (free, no account). The current line is big and white, with the lines before and after it dim, scrolling along with the song. Each song is looked up once and cached in `cache\lyrics\`. The tag says SEARCHING, NOT FOUND, INSTRUMENTAL or NOT SYNCED when there's nothing to scroll. Japanese and other CJK text uses the DotGothic16 pixel font.
- **Visualizer**: 32 bars showing the spectrum of whatever the PC is playing, with falling peak caps. The agent records the speakers' output (WASAPI loopback, nothing leaves the PC) and only while a screen is on the music page. It follows the default output device, so switching to headphones works. The bars scale to the music, like auto-gain, so system volume doesn't change them.

### Lock screen and haptics

When the PC is locked, asleep or off, the dashboard is replaced by a dim clock that moves around the screen ("PC locked" / "PC offline"). It comes back on its own.

Every button gives a short buzz when pressed, the volume bar clicks at each 5% step, and LOCK / SLEEP buzz again when they fire. Chrome only allows vibration after the first tap since the page loaded, so the very first tap after a reload is silent. Turn it off with `haptics` in `config.json`.

> [!TIP]
> Chrome never vibrates while the phone is in silent mode, and **Do Not Disturb counts as silent**, even when the sound setting is on vibrate. With DND on, the buzz is dropped without any error.

## Dashboard details

**Internet status.** The NET card shows the ping to 1.1.1.1, refreshed every 2 seconds. Its tag turns orange when the connection is slow (typical ping over `warn_ms`) or losing packets: 10% or more of the last minute's pings, shown as `· 10% LOSS`. One or two missed pings are normal blips and don't count. If nothing answers for about 6–8 seconds, the card turns red, the tag blinks **OFFLINE**, and the drive line becomes "no internet" with a timer. A message pops up when the connection drops and again when it comes back. If 1.1.1.1 doesn't answer, 8.8.8.8 is pinged, and a connection to port 443 (HTTPS) is tried on both, so a network that only blocks ping isn't shown as offline. Outages go into `logs\agent.log`.

**Rain alert.** The weather card warns about rain up to 2 hours ahead, from Open-Meteo's 15-minute forecast: **RAIN IN 20 MIN**, **STORM IN 20 MIN**, or while it rains **DRY BY 16:30** (just **RAINING** if it won't stop within 3 hours). It turns orange for thunderstorms and heavy rain (over about 8 mm/h), and a message pops up when rain is newly on its way. Light drizzle doesn't trigger it. In the big clock it's a badge in the weather row (the day's rain % is hidden meanwhile); in the classic layout it's the weather card's right-hand tag. Weather refreshes every 10 minutes, and the countdown runs live in between. Where Open-Meteo has no 15-minute model (Malaysia, for example) the steps are filled in from hourly data, so treat the time as roughly ±15 minutes.

**Air quality and UV.** The weather card shows the US air quality index for your location from Open-Meteo (CAMS model): **AQI 54** in grey normally, an orange block from 101 (unhealthy for sensitive groups, e.g. haze season), red from 151. The UV index appears from 3: grey, orange from 6 (high), red from 8 (very high).

**Prayer times.** With `prayer_zone` set, the clock card shows today's Fajr, Dhuhr, Asr, Maghrib and Isha from JAKIM's e-Solat service, with the current one outlined in yellow: the latest prayer whose time has come. Before Fajr that's still Isha from the night before, and from sunrise (Syuruk) until Dhuhr nothing is outlined, because Fajr time has ended. A message pops up for 6 seconds when each prayer time arrives. A week is fetched at a time and kept in `cache\`, so the times still show if the PC starts without internet.

**Next calendar event.** Shows your next event from Google Calendar (or any calendar that publishes an iCal / .ics link), with no sign-in. It's a tag between the date and phone tags on the big clock, and a line under the prayer times in the classic layout:

| Shown | When |
| --- | --- |
| `NOW TILL 15:45 · Standup` (lime) | An event is on |
| `IN 25 MIN · Standup` (orange from 15 min) | It starts within 2 hours |
| `17:00 · Dentist` | Later today |
| `TODAY · Deepavali` | An all-day event today, with nothing timed left today |
| `TMRW 09:00 · Standup` / `TUE 09:00 · …` / `01 DEC · …` | Nothing else today: the next event within `days_ahead` (a date once it's a week or more away) |

A message pops up `remind_minutes` before each timed event and again when it starts. Repeating events, time zones, moved or cancelled occurrences, and events you've declined are all handled. The calendar is downloaded every 5 minutes, so a new event can take up to 5 minutes to appear. Restarting the agent fetches it at once.

To add your Google Calendar:
1. In Google Calendar on the web, open ⚙ **Settings**, then under **Settings for my calendars** click your calendar → **Integrate calendar**.
2. Copy **Secret address in iCal format** (ends in `/basic.ics`).
3. Add it to the `calendar.ics` list in `config.json`, then run `.\scripts\restart-agent.ps1`.

`config.example.json` already includes Google's public Malaysian holiday calendar. With `"holiday_region": "Penang"`, only national holidays and that state's own are kept. Other states' holidays and observances that aren't days off (Valentine's Day, Christmas Eve, New Year's Eve) are dropped, and "(regional holiday)" is trimmed from titles. Swap in your own country's holiday calendar from Google Calendar's *Browse calendars of interest*.

> [!WARNING]
> Anyone with your calendar's secret address can read your calendar, so keep it out of chats, screenshots and commits (`config.json` is git-ignored for this reason). If it leaks, use **Reset** next to it in Google Calendar to make a new one. The agent never writes it to the log; errors only say "calendar 1", "calendar 2", and so on. Event titles do show on the phone, so they're visible to anyone at your desk.

## Configuration

Settings live in `config.json` in the project folder (copy it from `config.example.json`). The agent reads it at startup, so after editing run `.\scripts\restart-agent.ps1`. Anything you leave out uses the default below. Saving with a UTF-8 byte-order mark (Notepad, PowerShell 5.1) is fine.

| Field | Default | Meaning |
| --- | --- | --- |
| `port` | `8765` | Local port for the web page and the USB tunnel |
| `city` | `""` | Weather location, looked up with Open-Meteo's geocoder |
| `latitude`, `longitude` | `null` | Set both to skip the city lookup |
| `clock_24h` | `true` | Default clock format (tapping the clock overrides it on the phone) |
| `layout` | `"bigclock"` | Default clock style, `"bigclock"` or `"classic"` (the control page's clock style button overrides it on the phone) |
| `apps` | auto | App buttons on the control page, up to six (see below). Leave it out to auto-detect |
| `phone_serial` | `""` | Which phone to use if several are plugged in (from `adb devices`) |
| `phone_app_package` | `""` | Empty = auto-detect the installed web app. `"none"` = never auto-open it |
| `adb_path` | `""` | Only needed if `adb.exe` isn't on PATH or in the Android SDK folder |
| `night_dim` | `00:00`–`07:00`, `0.6` | Darken the screen by this much overnight (0 = off) |
| `idle_dim_minutes` | `10` | Half-dim after this many minutes without keyboard/mouse input (0 = off) |
| `pixel_shift_minutes` | `3` | Nudge the whole layout a few pixels this often (burn-in protection, 0 = off) |
| `ping` | `{"hosts": ["1.1.1.1", "8.8.8.8"], "warn_ms": 100}` | Internet check. The first host is the one whose ping is shown; the others are only tried when it doesn't answer. `"hosts": []` turns it off |
| `prayer_zone` | `""` | JAKIM e-Solat zone code, e.g. `PNG01` for Pulau Pinang or `WLY01` for Kuala Lumpur (full list on e-solat.gov.my). Empty = no prayer times |
| `haptics` | `true` | Vibrate on button presses |
| `calendar` | `{"ics": [], "days_ahead": 7, "remind_minutes": 5, "holiday_region": ""}` | `ics`: iCal addresses (see Next calendar event). `days_ahead`: how far ahead to look. `remind_minutes`: message this long before an event (0 = none). `holiday_region`: state whose holidays to keep from a holiday calendar (empty = all) |

Custom app buttons: each entry has a `label` plus either `run` (an exe, optional `args`) or `open` (a URI, file or folder). Paths need doubled backslashes in JSON:

```json
"apps": [
  { "label": "Discord", "run": "C:\\Users\\you\\AppData\\Local\\Discord\\Update.exe", "args": "--processStart Discord.exe" },
  { "label": "Steam", "open": "steam://open/main" },
  { "label": "Downloads", "open": "C:\\Users\\you\\Downloads" }
]
```

> [!IMPORTANT]
> The phone only sends the button's number; the command itself is read from `config.json` on the PC, so nothing arbitrary can be run from the phone. The agent also refuses connections from other websites: browsers send an `Origin` header, and only `http://localhost:<port>` is accepted.

## Project layout

| Path | What |
| --- | --- |
| `agent/` | The PC side. `python -m agent` runs it |
| `agent/stats.py` | CPU, per-core, top app, RAM, disks, network (psutil); GPU (NVIDIA NVML) |
| `agent/media.py` | Now playing, pixelated album art, play/pause/skip (Windows media sessions) |
| `agent/weather.py` | Open-Meteo forecast, air quality and UV (free, no API key) and the 15-minute rain alert |
| `agent/ping.py` | Internet check: ICMP ping through Windows' own API (no admin, no ping.exe), HTTPS fallback |
| `agent/lyrics.py` | Synced lyrics from LRCLIB, cached in `cache/lyrics/` |
| `agent/visualizer.py` | Spectrum of the PC's sound for the music page (SoundCard WASAPI loopback + numpy FFT) |
| `agent/calendar_feed.py` | Next events from iCal feeds (icalendar + recurring-ical-events) |
| `agent/solat.py` | Prayer times from JAKIM e-Solat (free, no API key), cached in `cache/` |
| `agent/adb.py` | Keeps the USB tunnel up, reads phone battery, finds and opens the web app |
| `agent/winstate.py` | Is the PC locked, how long since last input |
| `agent/controls.py` | Control page actions: volume and mic (pycaw), app launcher, screenshot, show desktop, lock, sleep |
| `agent/lhm.py` | Optional CPU temperature from LibreHardwareMonitor (see below) |
| `web/` | The phone page: `index.html` (all layouts and pages), `style.css`, `app.js`, `pixels.js` (hand-drawn pixel icons), service worker, manifest, fonts |
| `scripts/` | Autostart, restart, icon and LibreHardwareMonitor helpers (see below) |
| `config.example.json` | Starting point for your `config.json` |
| `logs/agent.log` | Agent log, rotated at 1 MB (created at runtime) |
| `cache/` | Downloaded prayer times and lyrics (created at runtime, safe to delete) |

Open screens reload themselves when files in `web/` change. The agent waits until the folder has been unchanged for 5 seconds before telling them, so a half-saved edit never goes out. If the page script ever fails to start, the page reloads itself after 15 seconds instead of staying black. Python changes need `restart-agent.ps1`.

Layouts live side by side in `web/index.html` as `<main class="board" data-layout="...">` blocks. Live values are bound by name (`data-b="cpuUtil"`, `data-seg="ram"`, `data-spark="cpu"`), so a new layout only needs markup and CSS. Add its name to `LAYOUTS` in `web/app.js`.

## Scripts

| Script | What it does |
| --- | --- |
| `scripts\install-autostart.ps1` | Creates the "MiniScreen Agent" logon task (no admin needed) |
| `scripts\restart-agent.ps1` | Stops the running agent and starts it again in the background |
| `scripts\uninstall-autostart.ps1` | Removes the logon tasks |
| `scripts\make_icons.py` | Redraws the pixel-art app icons in `web/icons/` |
| `scripts\setup-lhm.ps1` | Optional, needs admin: see CPU temperature below |

## CPU temperature (optional)

Windows doesn't expose CPU temperature on many systems (Ryzen especially). LibreHardwareMonitor can, but it has to run as admin. Install it with `winget install LibreHardwareMonitor.LibreHardwareMonitor`, then run this from a normal PowerShell in the project folder and click Yes on the admin prompt:

```powershell
$exe = (Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\LibreHardwareMonitor*" -Recurse -Filter LibreHardwareMonitor.exe).FullName
Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File `"$PWD\scripts\setup-lhm.ps1`" -Exe `"$exe`" -User `"$env:USERDOMAIN\$env:USERNAME`""
```

It makes LibreHardwareMonitor start minimized to the tray at each logon. The agent reads its sensors from local WMI, with no network port. The CPU card then gets a temperature tag, package power and clock.

## Things to know

- **Burn-in.** AMOLED screens can burn in over months with a static layout. Mitigations: pure black background, the layout shifts a few pixels every 3 minutes, night and idle dimming, and the dashboard blanks to a moving dim clock when the PC is locked or off. Lower `night_dim` start/end or raise its level if you see ghosting.
- **Battery.** Being plugged in 24/7 wears the battery, and many phones have no 80% charge limit without root. Keep the phone where air can flow, and unplug it if the back ever bulges. The clock card shows the phone's battery % and temperature, which turns red at 42 °C. If the phone is ever unplugged and drops below 30%, the page lets the screen sleep.
- **Unlocked phone.** The web app keeps the screen on, so the phone sits unlocked on the desk. Anyone can swipe out of it into your other apps.

## Troubleshooting

- **Phone says "PC offline"**: check `adb devices` lists the phone as `device` (approve the USB debugging prompt on the phone if it says `unauthorized`), then look at `logs\agent.log`.
- **Nothing on port 8765**: run `.\scripts\restart-agent.ps1`. If it still fails, run `.\.venv\Scripts\python.exe -m agent` in a terminal to see errors.
- **Weather card shows an error**: check `city` in `config.json`, or set `latitude`/`longitude`.

## Uninstall

1. Remove the logon tasks and stop the running agent:
   ```powershell
   .\scripts\uninstall-autostart.ps1
   Get-NetTCPConnection -LocalPort 8765 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess }
   ```
2. On the phone, long-press the **Mini Screen** app → Uninstall. Optionally `adb reverse --remove-all`.
3. Optionally `winget uninstall LibreHardwareMonitor.LibreHardwareMonitor`.
4. Delete the project folder.

## Credits

- Weather, air quality and geocoding: [Open-Meteo](https://open-meteo.com) (free, no API key)
- Synced lyrics: [LRCLIB](https://lrclib.net)
- Prayer times: [JAKIM e-Solat](https://www.e-solat.gov.my)
- Fonts: [Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P), [VT323](https://fonts.google.com/specimen/VT323) and [DotGothic16](https://fonts.google.com/specimen/DotGothic16), under the SIL Open Font License 1.1 (see [`web/fonts/OFL.txt`](web/fonts/OFL.txt))

## License

[MIT](LICENSE) © 2026 danishayman. The bundled fonts keep their own license (SIL OFL 1.1).
