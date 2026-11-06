(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const W = 880, H = 396, HIST = 48;
  const LAYOUTS = ["bigclock", "classic"];  // clock page styles
  const LAYOUT_NAMES = { bigclock: "BIG CLOCK", classic: "CLASSIC" };
  const CONTROLS_TIMEOUT = 45000;  // control page returns to the clock after this long untouched
  const MUSIC_TIMEOUT = 120000;    // music page returns to the clock after this long with nothing playing
  // Pages in swipe order: swipe left moves right along this list, swipe right moves left (wrapping).
  const PAGES = ["main", "music", "controls"];
  const PAGE_NAMES = { main: "CLOCK", music: "MUSIC", controls: "CONTROLS" };

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };

  const cfg = { clock_24h: true, layout: "bigclock", night_dim: { start: "00:00", end: "07:00", level: 0.6 }, idle_dim_minutes: 10, pixel_shift_minutes: 3, haptics: true };
  let use24 = store.get("clock24", null);
  let chosenLayout = store.get("layout", null);
  let last = null, lastMsg = 0, version = null;
  const shift = { x: 0, y: 0 };
  let lastShift = Date.now();

  // ---------- binding helpers (every layout shows the same named values) ----------
  const bound = new Map();
  function els(key) {
    let list = bound.get(key);
    if (!list) { list = Array.from(document.querySelectorAll(`[data-b="${key}"]`)); bound.set(key, list); }
    return list;
  }
  function txt(key, value) {
    const s = String(value);
    for (const e of els(key)) if (e.textContent !== s) e.textContent = s;
  }
  function html(key, value) { for (const e of els(key)) e.innerHTML = value; }
  function each(key, fn) { els(key).forEach(fn); }

  document.querySelectorAll("[data-seg]").forEach((el) => { el.innerHTML = "<i></i>".repeat(+el.dataset.n || 10); });
  document.querySelectorAll("[data-spark]").forEach((el) => { el.innerHTML = "<i></i>".repeat(+el.dataset.n || HIST); });

  const segBars = new Map();
  function fillSeg(key, frac) {
    let list = segBars.get(key);
    if (!list) {
      list = Array.from(document.querySelectorAll(`[data-seg="${key}"]`)).map((el) => Array.from(el.children));
      segBars.set(key, list);
    }
    const f = Math.max(0, Math.min(1, frac || 0));
    for (const bars of list) {
      const on = Math.round(f * bars.length);
      for (let i = 0; i < bars.length; i++) bars[i].classList.toggle("on", i < on);
    }
  }
  function drawSpark(key, hist) {
    document.querySelectorAll(`[data-spark="${key}"]`).forEach((el) => {
      const bars = el.children, n = bars.length, step = (+el.dataset.h || 32) / 8;
      for (let i = 0; i < n; i++) {
        const idx = hist.length - n + i;
        const v = idx < 0 ? 0 : hist[idx];
        bars[i].style.height = Math.ceil((v / 100) * 8) * step + "px"; // 8 blocky levels
      }
    });
  }
  const cpuHist = [], gpuHist = [];

  document.querySelectorAll(".pbtn").forEach((b) => { b.innerHTML = Pixels.svg(b.dataset.action === "toggle" ? "play" : b.dataset.action); });
  document.querySelectorAll("[data-icon]").forEach((el) => { el.innerHTML = Pixels.svg(el.dataset.icon); });
  html("art", Pixels.svg("note"));
  html("wicon", Pixels.svg("cloud"));

  // ---------- pages and layouts ----------
  // Two pages: the clock ("main", drawn in the chosen clock layout) and "controls".
  const boards = Array.from(document.querySelectorAll(".board"));
  let board = boards[0];
  let page = "main";
  let lastTouch = Date.now();

  function currentLayout() {
    const l = chosenLayout || cfg.layout;
    return LAYOUTS.includes(l) ? l : LAYOUTS[0];
  }
  function applyLayout() {
    const l = page === "main" ? currentLayout() : page;
    boards.forEach((b) => { b.hidden = b.dataset.layout !== l; });
    board = boards.find((b) => !b.hidden) || boards[0];
    txt("layoutName", LAYOUT_NAMES[currentLayout()].replace(" ", "\n"));
    fit();
  }
  let toastTimer = null;
  function toast(msg, err, ms) {
    if (!msg) return;
    const t = $("toast");
    t.textContent = msg;
    t.classList.toggle("err", !!err);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 1500);
  }

  // Haptics: a short buzz when a button is pressed, so taps feel like real buttons.
  // Chrome only allows vibration after the first tap since the page loaded.
  // Durations in ms. Phone vibration motors barely register under ~20 ms, so taps are 35.
  const BUZZ = { tap: 35, tick: 15, fire: [60, 50, 90], err: [80, 70, 80] };
  function buzz(kind) {
    if (cfg.haptics === false || !navigator.vibrate) return;
    try { navigator.vibrate(BUZZ[kind]); } catch (e) { /* not allowed yet */ }
  }
  function setPage(p) {
    if (p === page) return;
    page = p;
    applyLayout();
    toast(PAGE_NAMES[p]);
    reportPage();
    lyrIdx = -2;  // lyric positions need measuring again once the page is visible
    if (p === "music") startMusic();
  }
  function cycleClockLayout() {
    const i = LAYOUTS.indexOf(currentLayout());
    chosenLayout = LAYOUTS[(i + 1) % LAYOUTS.length];
    store.set("layout", chosenLayout);
    applyLayout();
    toast("CLOCK: " + LAYOUT_NAMES[chosenLayout]);
  }

  function fit() {
    const s = Math.min(innerWidth / W, innerHeight / H);
    board.style.transform = `translate(${shift.x}px, ${shift.y}px) scale(${s})`;
  }
  addEventListener("resize", fit);

  const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  function maybeShift() {
    // Burn-in protection: nudge the whole layout a few pixels every few minutes.
    const every = (cfg.pixel_shift_minutes || 0) * 60000;
    if (!every || Date.now() - lastShift < every) return;
    lastShift = Date.now();
    shift.x = rand(-5, 5);
    shift.y = rand(-4, 4);
    fit();
  }

  // ---------- formatting ----------
  const pad = (n) => String(n).padStart(2, "0");
  const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const DAYS_LONG = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
  const MONS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const gb = (b) => (b / 1073741824).toFixed(1);
  function rate(b) {
    if (b == null) return "--";
    const u = ["B/s", "KB/s", "MB/s", "GB/s"];
    let i = 0;
    while (b >= 1000 && i < 3) { b /= 1024; i++; }
    return (b < 10 && i > 0 ? b.toFixed(1) : Math.round(b)) + " " + u[i];
  }
  function rateShort(b) {
    if (b == null) return "--";
    const u = ["B", "K", "M", "G"];
    let i = 0;
    while (b >= 1000 && i < 3) { b /= 1024; i++; }
    return (b < 10 && i > 0 ? b.toFixed(1) : Math.round(b)) + u[i];
  }
  const dur = (s) => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ":" + pad(s % 60); };
  function uptime(s) {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `up ${d}d ${h}h` : `up ${h}h ${m}m`;
  }
  function heat(el, t, warm, hot) {
    el.classList.toggle("warm", t != null && t >= warm && t < hot);
    el.classList.toggle("hot", t != null && t >= hot);
  }

  // ---------- clock ----------
  let weekKey = "";
  function renderWeek(d) {
    const key = d.toDateString();
    if (key === weekKey) return;
    weekKey = key;
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    let out = "";
    for (let i = 0; i < 7; i++) {
      const day = new Date(monday);
      day.setDate(monday.getDate() + i);
      const today = day.toDateString() === key;
      out += `<i class="${today ? "today" : ""}"><b>${DAYS[day.getDay()].slice(0, 2)}</b><span>${pad(day.getDate())}</span></i>`;
    }
    html("week", out);
  }

  // Center the big clock by its visible pixels, not its text box: the pixel font's digits
  // carry uneven blank space, so e.g. "12:21" would otherwise sit off-centre.
  const inkCtx = document.createElement("canvas").getContext("2d");
  let inkKey = "";
  function centerBigTime(text) {
    if (text === inkKey) return;
    inkKey = text;
    document.querySelectorAll(".bigtime").forEach((el) => {
      const cs = getComputedStyle(el);
      inkCtx.font = `${cs.fontSize} ${cs.fontFamily}`;
      if ("letterSpacing" in inkCtx) inkCtx.letterSpacing = cs.letterSpacing;
      const m = inkCtx.measureText(text);
      const shift = m.width / 2 - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
      el.style.transform = `translateX(${shift.toFixed(1)}px)`;
    });
  }
  // Metrics are only right once the pixel font has loaded.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { inkKey = ""; renderClock(new Date()); });

  function is24() { return use24 !== null ? use24 : !!cfg.clock_24h; }
  function renderClock(d) {
    let h = d.getHours();
    const h24 = is24();
    const ampm = h < 12 ? "AM" : "PM";
    if (!h24) h = h % 12 || 12;
    const hh = h24 ? pad(h) : String(h);
    txt("hh", hh);
    txt("mm", pad(d.getMinutes()));
    centerBigTime(`${hh}:${pad(d.getMinutes())}`);
    each("colon", (e) => e.classList.toggle("off", d.getSeconds() % 2 === 1));
    txt("ss", pad(d.getSeconds()));
    fillSeg("sec", (d.getSeconds() + 1) / 60);
    each("ampm", (e) => { e.hidden = h24; e.textContent = ampm; });
    txt("date", `${DAYS[d.getDay()]} ${pad(d.getDate())} ${MONS[d.getMonth()]}`);
    txt("dateLong", `${DAYS_LONG[d.getDay()]} ${pad(d.getDate())} ${MONS[d.getMonth()]}${h24 ? "" : " · " + ampm}`);
    renderWeek(d);
    $("saverClock").textContent = `${hh}:${pad(d.getMinutes())}`;
  }
  // ---------- prayer times (JAKIM e-Solat, sent by the agent) ----------
  // [key the agent sends (JAKIM's Malay name), label shown]
  const SOLAT = [["subuh", "FAJR"], ["zohor", "DHUHR"], ["asar", "ASR"], ["maghrib", "MAGHRIB"], ["isyak", "ISHA"]];
  const hm = (t) => { const [h, m] = String(t).split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  function clockTxt(t) {  // "13:04" -> "1:04" in 12-hour mode
    if (is24()) return t;
    const m = hm(t);
    return `${Math.floor(m / 60) % 12 || 12}:${pad(m % 60)}`;
  }
  let solatKey = "", solatToasted = "";
  function renderSolat(d) {
    const sv = last && last.solat;
    const show = !!(sv && sv.today);
    each("solat", (e) => { e.hidden = !show; });
    if (!show) return;
    const now = d.getHours() * 60 + d.getMinutes();
    // Highlight the current prayer: the latest one whose time has come. Before Fajr it's
    // still Isha (from last night); from sunrise (syuruk) until Dhuhr no prayer time is on.
    const day = sv.today;
    let cur = -1;
    SOLAT.forEach(([k], i) => { if (hm(day[k]) <= now) cur = i; });
    if (cur < 0) cur = SOLAT.length - 1;
    else if (cur === 0 && day.syuruk && now >= hm(day.syuruk)) cur = -1;
    const key = `${JSON.stringify(day)}|${cur}|${is24()}`;
    if (key !== solatKey) {
      solatKey = key;
      html("solat", SOLAT.map(([k, label], i) =>
        `<i class="${i === cur ? "now" : ""}"><b>${label}</b><span>${clockTxt(day[k])}</span></i>`).join(""));
    }
    // When a prayer time comes in, say so for a few seconds.
    const arrived = SOLAT.find(([k]) => hm(sv.today[k]) === now);
    const tk = arrived ? d.toDateString() + arrived[0] : "";
    if (arrived && tk !== solatToasted) {
      solatToasted = tk;
      if (!saverOn) toast(`${arrived[1]} ${clockTxt(sv.today[arrived[0]])}`, false, 6000);
    }
  }

  // ---------- calendar: the next event (from the agent's iCal feeds) ----------
  // Which event to show: one that's on now, else the next timed one today, else today's
  // all-day event, else whatever comes next. Events are sorted by start (unix seconds).
  function pickEvent(evs, now) {
    const live = evs.filter((e) => e.end > now);
    const n = new Date(now * 1000);
    const endOfToday = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1).getTime() / 1000;
    return live.find((e) => !e.allday && e.start <= now)
      || live.find((e) => !e.allday && e.start < endOfToday)
      || live.find((e) => e.allday && e.start <= now)
      || live.find((e) => e.start > now)
      || null;
  }
  function eventText(e, now) {
    const d = new Date(e.start * 1000), n = new Date(now * 1000);
    const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 86400000);
    // Tomorrow, a weekday within the week, or a date ("01 DEC") further out
    const day = days === 1 ? "TMRW" : days < 7 ? DAYS[d.getDay()] : `${pad(d.getDate())} ${MONS[d.getMonth()]}`;
    const at = (t) => clockTxt(hhmmOf(t));
    if (e.allday) return { text: `${days <= 0 ? "TODAY" : day} · ${e.title}`, state: "" };
    if (e.start <= now) return { text: `NOW TILL ${at(e.end)} · ${e.title}`, state: "now" };
    if (days > 0) return { text: `${day} ${at(e.start)} · ${e.title}`, state: "" };
    const mins = Math.ceil((e.start - now) / 60);
    if (mins > 120) return { text: `${at(e.start)} · ${e.title}`, state: "" };
    const left = mins < 60 ? `${mins} MIN` : `${Math.floor(mins / 60)}H ${pad(mins % 60)}M`;
    return { text: `IN ${left} · ${e.title}`, state: mins <= 15 ? "soon" : "" };
  }
  let evToasted = "";
  function renderCalendar(d) {
    const c = last && last.calendar;
    const now = d.getTime() / 1000;
    const e = c && c.events ? pickEvent(c.events, now) : null;
    const r = e ? eventText(e, now) : null;
    for (const key of ["evTag", "evLine"]) {
      each(key, (el) => {
        el.hidden = !r;
        if (!r) return;
        if (el.textContent !== r.text) el.textContent = r.text;
        el.dataset.state = r.state;
      });
    }
    // Reminder: a message remind_minutes before a timed event, and again when it starts.
    if (!e || e.allday || saverOn) return;
    const mins = Math.ceil((e.start - now) / 60);
    const id = `${e.start}|${e.title}`;
    let k = "";
    if (c.remind && mins === c.remind) k = id + "|remind";
    else if (e.start <= now && now - e.start < 60) k = id + "|start";
    if (k && k !== evToasted) { evToasted = k; toast(r.text, false, 8000); }
  }

  function tickClock() {
    const d = new Date();
    renderClock(d);
    renderSolat(d);
    renderCalendar(d);
    updateSaver();
    updateDim(d);
    maybeShift();
    if (page === "controls" && Date.now() - lastTouch > CONTROLS_TIMEOUT) setPage("main");
    if (page === "music") {
      const quiet = Date.now() - Math.max(lastTouch, play.lastPlaying);
      if (!play.playing && quiet > MUSIC_TIMEOUT) setPage("main");
      else startMusic();  // no-op while already running
    }
    if (d.getSeconds() % 20 === 0) moveSaver();
    setTimeout(tickClock, 1000 - (Date.now() % 1000) + 5);
  }

  // ---------- render ----------
  function renderCpu(c) {
    txt("cpuUtil", Math.round(c.util));
    cpuHist.push(c.util); if (cpuHist.length > HIST) cpuHist.shift();
    drawSpark("cpu", cpuHist);
    fillSeg("cpu", c.util / 100);
    document.querySelectorAll("[data-cores]").forEach((el) => {
      if (el.children.length !== c.cores.length) el.innerHTML = "<i></i>".repeat(c.cores.length);
      c.cores.forEach((v, i) => {
        const lv = Math.ceil((v / 100) * 6);
        el.children[i].style.height = (lv ? lv * 5 : 2) + "px";
      });
    });
    each("cpuTemp", (t) => {
      t.hidden = c.temp == null;  // only shown when LibreHardwareMonitor is running
      if (c.temp != null) t.textContent = Math.round(c.temp) + "°C";
      heat(t, c.temp, 75, 88);
    });
    const meta = [];
    if (c.power != null) meta.push(Math.round(c.power) + " W");
    if (c.clock != null) meta.push((c.clock / 1000).toFixed(2) + " GHz");
    if (c.top) meta.push(`top: ${c.top.name} ${Math.round(c.top.pct)}%`);
    else meta.push(c.cores.length + " threads");
    txt("cpuMeta", meta.join(" · "));
    txt("cpuTop", c.top ? `top: ${c.top.name}` : `${c.cores.length} threads`);
  }

  function renderGpu(g) {
    if (!g) { txt("gpuMeta", "no NVIDIA GPU"); return; }
    txt("gpuUtil", g.util);
    gpuHist.push(g.util); if (gpuHist.length > HIST) gpuHist.shift();
    drawSpark("gpu", gpuHist);
    fillSeg("gpu", g.util / 100);
    each("gpuTemp", (t) => { t.textContent = g.temp + "°C"; heat(t, g.temp, 75, 85); });
    txt("vramTxt", `${gb(g.mem_used)}/${gb(g.mem_total)}G`);
    fillSeg("vram", g.mem_used / g.mem_total);
    const meta = [];
    if (g.power != null) meta.push(Math.round(g.power) + " W");
    if (g.clock != null) meta.push(g.clock + " MHz");
    if (g.fan != null) meta.push("fan " + g.fan + "%");
    txt("gpuMeta", meta.join(" · "));
    txt("gpuPower", g.power != null ? Math.round(g.power) + " W" : "");
  }

  // Rain alert text from the agent's 15-minute forecast ("at"/"until" are unix seconds).
  const hhmmOf = (t) => { const d = new Date(t * 1000); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
  function rainText(a, now) {
    if (a.kind === "now") return a.until ? "DRY BY " + clockTxt(hhmmOf(a.until)) : a.storm ? "STORMING" : "RAINING";
    const what = a.storm ? "STORM" : "RAIN";
    const mins = Math.round((a.at - now) / 300) * 5;  // nearest 5 minutes; the forecast isn't finer than that
    if (mins <= 5) return what + " ANY MIN";
    return `${what} IN ${mins < 60 ? mins + " MIN" : Math.floor(mins / 60) + "H " + pad(mins % 60) + "M"}`;
  }

  let wIcon = null, rainWasSoon = null;
  function renderWeather(w, now) {
    if (!w) return;
    if (w.error) {
      txt("wtemp", "--°");
      txt("wlabel", w.error);
      txt("wmetaBc", " ");
      each("walert", (e) => { e.hidden = true; });
      each("aqi", (e) => { e.hidden = true; });
      each("uv", (e) => { e.hidden = true; });
      txt("wmeta", " ");
      return;
    }
    txt("wplace", w.place || "weather");
    txt("wtemp", Math.round(w.temp) + "°");
    txt("wlabel", w.label);
    const parts = [];
    if (w.hi != null) parts.push(`H ${Math.round(w.hi)}° L ${Math.round(w.lo)}°`);
    if (w.rain != null) parts.push(`rain ${w.rain}%`);
    txt("wmeta", parts.join(" · "));
    if (w.icon !== wIcon) { wIcon = w.icon; html("wicon", Pixels.svg(w.icon)); }

    const a = w.alert;
    const alertTxt = a ? rainText(a, now) : "";
    each("walert", (e) => {
      e.hidden = !a;
      e.textContent = alertTxt;
      e.classList.toggle("warm", !!(a && (a.storm || a.heavy)));  // orange for storms and heavy rain
    });
    // The big clock's weather row is narrow: drop the day's rain % while an alert shows.
    txt("wmetaBc", (a ? parts.slice(0, 1) : parts).join(" · ") || " ");
    // Air quality (US AQI): orange from 101 (unhealthy for sensitive groups), red from 151.
    each("aqi", (e) => {
      e.hidden = w.aqi == null;
      if (w.aqi == null) return;
      e.textContent = "AQI " + Math.round(w.aqi);
      e.classList.toggle("warm", w.aqi > 100 && w.aqi <= 150);
      e.classList.toggle("hot", w.aqi > 150);
    });
    // UV index: shown from 3 (moderate), orange from 6 (high), red from 8 (very high).
    each("uv", (e) => {
      const uv = w.uv == null ? null : Math.round(w.uv);
      e.hidden = uv == null || uv < 3;
      if (e.hidden) return;
      e.textContent = "UV " + uv;
      e.classList.toggle("warm", uv >= 6 && uv < 8);
      e.classList.toggle("hot", uv >= 8);
    });
    // Pop a message when rain is newly on its way (not on page load).
    const soon = !!(a && a.kind === "soon");
    if (soon && rainWasSoon === false && !saverOn) toast(alertTxt, false, 5000);
    rainWasSoon = soon;
  }

  let playing = null;
  function setPlayIcon(p) {
    if (p === playing) return;
    playing = p;
    document.querySelectorAll(".pbtn.play").forEach((b) => { b.innerHTML = Pixels.svg(p ? "pause" : "play"); });
  }

  // Playback position, kept running between the once-a-second updates for the lyrics.
  const play = { pos: 0, at: 0, playing: false, lastPlaying: 0 };
  function playPos() { return play.pos + (play.playing ? (performance.now() - play.at) / 1000 : 0); }

  function renderMedia(m, now) {
    const has = m && m.title;
    each("mediaCard", (card) => card.classList.toggle("idle", !has));
    play.playing = !!(has && m.status === "playing");
    if (play.playing) play.lastPlaying = Date.now();
    if (has) {
      // m.pos was measured at m.pos_at (PC clock); add the time since, then count on locally.
      play.pos = m.pos + (play.playing && m.pos_at && now ? Math.max(0, now - m.pos_at) : 0);
      play.at = performance.now();
    }
    if (!has) {
      txt("mtitle", "nothing playing");
      txt("martist", " ");
      txt("mtime", "");
      each("mediaApp", (e) => { e.hidden = true; });
      fillSeg("media", 0);
      setPlayIcon(false);
      return;
    }
    txt("mtitle", m.title);
    txt("martist", m.artist || m.album || " ");
    each("mediaApp", (e) => { e.hidden = !m.app; e.textContent = m.app || ""; });
    fillSeg("media", m.end ? m.pos / m.end : 0);
    txt("mtime", m.end ? `${dur(m.pos)}/${dur(m.end)}` : "");
    setPlayIcon(m.status === "playing");
  }

  // ---------- music page: synced lyrics (LRCLIB, via the agent) ----------
  const LYR_MSG = {
    idle: "nothing playing", searching: "looking for lyrics…", none: "no lyrics found",
    instrumental: "♪ instrumental ♪", unsynced: "lyrics aren't time-synced", error: "lyrics unavailable (offline?)",
  };
  const LYR_TAG = { ok: "LRCLIB", searching: "SEARCHING", none: "NOT FOUND", instrumental: "INSTRUMENTAL", unsynced: "NOT SYNCED", error: "OFFLINE" };
  let lyr = { status: "idle", lines: [] }, lyrIdx = -2;
  function setLyrics(m) {
    lyr = m;
    lyrIdx = -2;
    const ok = m.status === "ok" && m.lines && m.lines.length;
    $("lyr").innerHTML = ok
      ? `<div class="lyr-list">${m.lines.map(([, t]) => `<p>${esc(t || "♪")}</p>`).join("")}</div>`
      : `<div class="lyr-msg">${esc(LYR_MSG[m.status] || "")}</div>`;
    txt("lyrState", LYR_TAG[m.status] || "--");
    txt("muTitle", m.title || "nothing playing");
    txt("muArtist", m.artist || " ");
  }
  function updateLyrics() {
    if (lyr.status !== "ok") return;
    const L = lyr.lines, t = playPos() + 0.2;  // a hair early reads better than late
    let i = -1, lo = 0, hi = L.length - 1;     // last line that has started
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (L[mid][0] <= t) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    if (i === lyrIdx) return;
    lyrIdx = i;
    const box = $("lyr"), list = box.firstElementChild;
    if (!list || !list.classList.contains("lyr-list")) return;
    const ps = list.children;
    for (let k = 0; k < ps.length; k++) {
      ps[k].classList.toggle("now", k === i);
      ps[k].classList.toggle("past", k < i);
    }
    const cur = ps[Math.max(0, i)];  // before the first line, centre the line that's coming
    list.style.transform = `translateY(${Math.round(box.clientHeight / 2 - (cur.offsetTop + cur.offsetHeight / 2))}px)`;
  }

  // ---------- music page: visualizer (spectrum of the PC's sound, ~30 frames/s) ----------
  const VIZ_ROWS = 14;
  const viz = { target: [], shown: [], peak: [], peakAt: [], last: 0, colors: null };
  function drawViz(dt, nowMs) {
    const cv = $("viz"), ctx = cv.getContext("2d");
    const r = cv.getBoundingClientRect();
    const w = Math.round(r.width * devicePixelRatio), h = Math.round(r.height * devicePixelRatio);
    if (!w || !h) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    if (!viz.colors) {
      const cs = getComputedStyle(document.documentElement), v = (k) => cs.getPropertyValue(k).trim();
      viz.colors = { low: v("--cyan"), mid: v("--yellow"), high: v("--pink"), off: v("--off"), cap: v("--white") };
    }
    const c = viz.colors, n = viz.target.length || 32, stale = nowMs - viz.last > 400;
    const gap = Math.max(1, Math.round(w / 260));
    const colW = (w - gap * (n - 1)) / n, rowH = (h - gap * (VIZ_ROWS - 1)) / VIZ_ROWS;
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < n; i++) {
      const target = stale ? 0 : (viz.target[i] || 0) / 100;
      // Bars jump up at once and fall back smoothly; a white cap marks each recent peak.
      viz.shown[i] = Math.max(target, (viz.shown[i] || 0) - dt * 1.8);
      if (viz.shown[i] >= (viz.peak[i] || 0)) { viz.peak[i] = viz.shown[i]; viz.peakAt[i] = nowMs; }
      else if (nowMs - viz.peakAt[i] > 350) viz.peak[i] = Math.max(0, viz.peak[i] - dt * 0.7);
      const lit = Math.round(viz.shown[i] * VIZ_ROWS), cap = Math.min(VIZ_ROWS - 1, Math.round(viz.peak[i] * VIZ_ROWS));
      const x0 = Math.round(i * (colW + gap)), x1 = Math.round(i * (colW + gap) + colW);
      for (let row = 0; row < VIZ_ROWS; row++) {
        const y1 = Math.round(h - row * (rowH + gap)), y0 = Math.round(h - row * (rowH + gap) - rowH);
        ctx.fillStyle = row < lit ? (row >= VIZ_ROWS * 0.85 ? c.high : row >= VIZ_ROWS * 0.6 ? c.mid : c.low)
          : row === cap && viz.peak[i] > 0.04 ? c.cap : c.off;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
  }

  // Lyrics and visualizer are redrawn every frame, but only while the music page is showing.
  let musicRaf = 0, lastFrame = 0;
  function musicFrame(ts) {
    musicRaf = 0;
    if (page !== "music" || saverOn) return;
    const dt = lastFrame ? Math.min(0.1, (ts - lastFrame) / 1000) : 0;
    lastFrame = ts;
    updateLyrics();
    drawViz(dt, ts);
    musicRaf = requestAnimationFrame(musicFrame);
  }
  function startMusic() {
    if (!musicRaf && page === "music" && !saverOn) { lastFrame = 0; musicRaf = requestAnimationFrame(musicFrame); }
  }

  // Tell the agent which page this screen shows: it only sends visualizer frames to
  // screens on the music page, and only captures the PC's sound while there are some.
  function reportPage() {
    send({ cmd: "page", page: document.visibilityState !== "visible" ? "hidden" : saverOn ? "saver" : page });
  }
  document.addEventListener("visibilitychange", reportPage);

  // ---------- control page ----------
  let volHoldUntil = 0, volIconKey = "", micIconKey = "";
  function showVol(v) {
    txt("vol", v == null ? "--" : Math.round(v));
    fillSeg("vol", (v || 0) / 100);
  }
  function renderAudio(a) {
    if (!a) { txt("volState", "NO DEVICE"); return; }
    if (Date.now() > volHoldUntil) showVol(a.vol);  // don't fight the finger while dragging
    txt("volState", a.muted ? "MUTED" : "ON");
    const vk = a.muted ? "speakerx" : "speaker";
    if (vk !== volIconKey) { volIconKey = vk; html("volIcon", Pixels.svg(vk)); }
    each("muteBtn", (b) => b.classList.toggle("on", !!a.muted));
    txt("muteLabel", a.muted ? "UNMUTE" : "MUTE");
    const noMic = a.mic_muted == null;
    txt("micState", noMic ? "NO MIC" : a.mic_muted ? "MUTED" : "LIVE");
    each("micCard", (c) => c.style.setProperty("--k", a.mic_muted || noMic ? "var(--hot)" : "var(--lime)"));
    const mk = a.mic_muted ? "micx" : "mic";
    if (mk !== micIconKey) { micIconKey = mk; html("micIcon", Pixels.svg(mk)); }
  }

  const APP_COLORS = ["var(--pink)", "var(--lime)", "var(--yellow)", "var(--purple)", "var(--orange)", "var(--cyan)"];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  let appsKey = null;
  function buildApps(labels) {
    labels = labels || [];
    const key = labels.join("|");
    if (key === appsKey) return;
    appsKey = key;
    $("appGrid").innerHTML = labels.map((l, i) =>
      `<button class="cbtn appbtn" data-ctl="launch" data-v="${i}" style="--b:${APP_COLORS[i % APP_COLORS.length]}">` +
      `<span class="init">${esc(l.charAt(0) || "?")}</span><span class="name">${esc(l)}</span></button>`
    ).join("") || `<div class="sub">no apps set in config.json</div>`;
  }

  // ---------- internet (ping) ----------
  const downTxt = (s) => (s < 3600 ? dur(s) : `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`);
  let netLevel = null, downFor = 0;
  function renderPing(s) {
    const p = s.ping;
    const hide = p === undefined || (p && p.level === "off");  // older agent, or turned off
    const level = p ? p.level : "wait";                         // null = first check not done yet
    const offline = level === "offline";
    let label = "-- MS";
    if (offline) label = "OFFLINE";
    else if (p && p.ms != null) label = p.ms + " MS" + (p.loss ? ` · ${p.loss}% LOSS` : "");  // agent only sends loss worth showing
    const paint = (e) => { e.classList.toggle("warm", level === "warn"); e.classList.toggle("hot", offline); };
    each("pingTag", (e) => { e.hidden = hide; e.textContent = label; paint(e); });
    each("netTag", (e) => { e.textContent = hide ? "NET" : "NET " + label; paint(e); });
    each("netCard", (c) => c.style.setProperty("--k", offline ? "var(--hot)" : "var(--purple)"));
    if (offline) {
      downFor = Math.max(0, s.time - (p.down_since || s.time));
      txt("drives", "NO INTERNET FOR " + downTxt(downFor));
      txt("drivesShort", "NO INTERNET " + downTxt(downFor));
    }
    each("drives", (e) => e.classList.toggle("bad", offline));
    each("drivesShort", (e) => e.classList.toggle("bad", offline));
    if (netLevel && level !== netLevel && !saverOn) {
      if (offline) toast("INTERNET DOWN", true, 4000);
      else if (netLevel === "offline") toast("BACK ONLINE · DOWN " + downTxt(downFor), false, 4000);
    }
    netLevel = level;
  }

  function setArt(data) {
    html("art", data ? `<img alt="" src="${data}">` : Pixels.svg("note"));
  }

  function render(s) {
    renderCpu(s.cpu);
    renderGpu(s.gpu);

    txt("ramUsed", gb(s.ram.used));
    txt("ramTotal", `/ ${gb(s.ram.total)} GB`);
    each("ramPct", (e) => { e.textContent = Math.round(s.ram.pct) + "%"; heat(e, s.ram.pct, 80, 92); });
    fillSeg("ram", s.ram.pct / 100);

    txt("rx", rate(s.net.rx));
    txt("tx", rate(s.net.tx));
    txt("rxShort", rateShort(s.net.rx));
    txt("txShort", rateShort(s.net.tx));
    txt("rd", rate(s.disk.read));
    txt("wr", rate(s.disk.write));
    const drives = s.disk.drives || [];
    txt("drives", drives.map((d) => `${d.name} ${Math.round(d.free / 1073741824)}G free`).join(" · ") || " ");
    txt("drivesShort", drives.length ? drives.map((d) => `${d.name} ${Math.round(d.free / 1073741824)}G`).join(" · ") + " free" : " ");
    renderPing(s);  // after the drive lines: shows "no internet" in their place when offline

    txt("uptime", uptime(s.uptime));
    const p = s.phone;
    if (p) {
      const hot = p.temp >= 42;
      each("phone", (e) => {
        e.textContent = `phone ${p.battery}%${p.charging ? "+" : ""} ${Math.round(p.temp)}°`;
        e.style.color = hot ? "var(--hot)" : "";
      });
      each("phoneTag", (e) => {
        e.textContent = `phone ${p.battery}% ${Math.round(p.temp)}°C`;
        heat(e, p.temp, 40, 42);
      });
    }

    renderWeather(s.weather, s.time);
    renderMedia(s.media, s.time);
    renderAudio(s.audio);
  }

  // ---------- saver + dim ----------
  const online = () => Date.now() - lastMsg < 6000;
  let saverOn = false;
  function updateSaver() {
    const off = !online();
    const on = off || !!(last && last.locked);
    $("saverMsg").textContent = off ? "PC offline" : "PC locked";
    if (on !== saverOn) {
      saverOn = on;
      document.body.classList.toggle("saver", on);
      $("saver").hidden = !on;
      if (on) moveSaver();
      reportPage();
      startMusic();
    }
  }
  function moveSaver() {
    if (!saverOn) return;
    const c = $("saverClock"), m = $("saverMsg");
    const w = Math.max(c.offsetWidth, m.offsetWidth), h = c.offsetHeight + m.offsetHeight + 12;
    const x = Math.random() * Math.max(0, innerWidth - w);
    const y = Math.random() * Math.max(0, innerHeight - h);
    c.style.left = x + "px"; c.style.top = y + "px";
    m.style.left = x + "px"; m.style.top = y + c.offsetHeight + 12 + "px";
  }

  function minutes(hhmm) { const [h, m] = String(hhmm).split(":").map(Number); return (h || 0) * 60 + (m || 0); }
  function updateDim(d) {
    let lv = 0;
    const nd = cfg.night_dim;
    if (nd && nd.level) {
      const now = d.getHours() * 60 + d.getMinutes(), a = minutes(nd.start), b = minutes(nd.end);
      const inside = a <= b ? now >= a && now < b : now >= a || now < b;
      if (inside) lv = nd.level;
    }
    if (online() && last && cfg.idle_dim_minutes && last.idle >= cfg.idle_dim_minutes * 60) lv = Math.max(lv, 0.5);
    $("dim").style.opacity = lv;
  }

  // ---------- connection ----------
  let ws = null;
  function connect() {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = reportPage;
    ws.onmessage = (ev) => {
      lastMsg = Date.now();
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === "stats") {
        if (m.v) {
          if (version && m.v !== version) { location.reload(); return; }
          version = m.v;
        }
        last = m;
        render(m);
        updateSaver();
      } else if (m.t === "viz") {
        viz.target = m.b || [];
        viz.last = performance.now();
      } else if (m.t === "lyrics") {
        setLyrics(m);
      } else if (m.t === "hello") {
        Object.assign(cfg, m.config || {});
        applyLayout();
        buildApps(cfg.apps);
      } else if (m.t === "ack") {
        if (!m.ok) buzz("err");
        toast(m.msg, !m.ok);
        renderAudio(m.audio);
      } else if (m.t === "art") {
        setArt(m.data);
      }
    };
    ws.onclose = () => { ws = null; setTimeout(connect, 2000); };
    ws.onerror = () => { try { ws.close(); } catch (e) { /* already closed */ } };
  }
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  // ---------- input ----------
  document.querySelectorAll(".pbtn").forEach((b) => {
    const up = () => b.classList.remove("pressed");
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      b.classList.add("pressed");
      buzz("tap");
      if (b.dataset.action === "toggle") setPlayIcon(!playing);
      send({ cmd: "media", action: b.dataset.action });
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => b.addEventListener(ev, up));
  });

  // Swipe left or right anywhere to move between pages: swipe left from the clock for
  // music, swipe right for the controls (see PAGES).
  // Swipes may start on a control button (the button then doesn't fire), but not
  // on the media buttons or the volume slider, which react to the press itself.
  const stage = $("stage");
  let swipe = null;
  stage.addEventListener("pointerdown", (e) => {
    lastTouch = Date.now();
    swipe = e.target.closest(".pbtn, .volbar") ? null : { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  stage.addEventListener("pointerup", (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y, dt = Date.now() - swipe.t;
    swipe = null;
    if (Math.abs(dx) > 80 && Math.abs(dy) < 70 && dt < 900) {
      buzz("tap");
      const i = PAGES.indexOf(page);
      setPage(PAGES[(i + (dx < 0 ? 1 : -1) + PAGES.length) % PAGES.length]);
    }
  });
  stage.addEventListener("pointercancel", () => { swipe = null; });

  // Control buttons fire on release (if the finger didn't move away);
  // ".hold" buttons (lock, sleep) fire only after being held for 1 s.
  let press = null;
  function fireControl(el) {
    if (el.dataset.local === "layout") { cycleClockLayout(); return; }
    const v = el.dataset.v;
    send({ cmd: "control", action: el.dataset.ctl, value: v != null ? Number(v) : undefined });
  }
  function dropPress() {
    if (!press) return;
    clearTimeout(press.timer);
    press.el.classList.remove("pressed", "holding");
    press = null;
  }
  document.addEventListener("pointerdown", (e) => {
    const el = e.target.closest("[data-ctl], [data-local]");
    if (!el || el.closest(".board").hidden) return;
    dropPress();
    press = { el, x: e.clientX, y: e.clientY, timer: null, fired: false };
    el.classList.add("pressed");
    buzz("tap");
    if (el.classList.contains("hold")) {
      el.classList.add("holding");
      const p = press;
      p.timer = setTimeout(() => { p.fired = true; p.el.classList.remove("holding"); buzz("fire"); fireControl(p.el); }, 1000);
    }
  });
  document.addEventListener("pointermove", (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 25) dropPress();  // it's a swipe
  });
  document.addEventListener("pointerup", () => {
    if (!press) return;
    const p = press;
    dropPress();
    if (p.fired) return;
    if (p.el.classList.contains("hold")) { buzz("err"); toast("HOLD TO " + p.el.dataset.ctl.toUpperCase(), true); return; }
    fireControl(p.el);
  });
  document.addEventListener("pointercancel", dropPress);

  // Volume bar: tap or drag. Sends at most ~8 updates a second while dragging.
  const volBar = $("volBar");
  let volDrag = false, volSentAt = 0, volShown = null;
  function volFromEvent(e) {
    const r = volBar.getBoundingClientRect();
    return Math.ceil(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 20) * 5;
  }
  function volSet(v, final) {
    if (v !== volShown) { volShown = v; buzz("tick"); }  // a small click at every 5% step
    volHoldUntil = Date.now() + 1500;
    showVol(v);
    if (final || Date.now() - volSentAt > 120) {
      volSentAt = Date.now();
      send({ cmd: "control", action: "vol_set", value: v });
    }
  }
  volBar.addEventListener("pointerdown", (e) => {
    volDrag = true;
    volShown = null;
    try { volBar.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
    volSet(volFromEvent(e));
  });
  volBar.addEventListener("pointermove", (e) => { if (volDrag) volSet(volFromEvent(e)); });
  volBar.addEventListener("pointerup", (e) => { if (volDrag) { volDrag = false; volSet(volFromEvent(e), true); } });
  volBar.addEventListener("pointercancel", () => { volDrag = false; });

  // Tap a clock card to switch 12/24h; hold it for 2 s to reload the page.
  document.querySelectorAll(".clockCard").forEach((card) => {
    let timer = null, held = false, sx = 0, sy = 0;
    const cancel = () => { clearTimeout(timer); timer = null; };
    card.addEventListener("pointerdown", (e) => {
      held = false; sx = e.clientX; sy = e.clientY;
      timer = setTimeout(() => { held = true; buzz("fire"); location.reload(); }, 2000);
    });
    card.addEventListener("pointermove", (e) => {
      if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 20) cancel();
    });
    card.addEventListener("pointerup", (e) => {
      cancel();
      if (held || Math.hypot(e.clientX - sx, e.clientY - sy) > 20) return;  // a hold or a swipe
      buzz("tap");
      use24 = !is24();
      store.set("clock24", use24);
      renderClock(new Date());
    });
    card.addEventListener("pointercancel", cancel);
  });
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  // ---------- keep the screen on ----------
  let wakeLock = null, allowWake = true;
  async function keepAwake() {
    if (!("wakeLock" in navigator) || !allowWake || wakeLock || document.visibilityState !== "visible") return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch (e) { wakeLock = null; }
  }
  document.addEventListener("visibilitychange", keepAwake);
  document.addEventListener("pointerdown", keepAwake);
  setInterval(keepAwake, 30000);
  // Safety net: if the phone is unplugged and the battery runs low, let it sleep.
  if (navigator.getBattery) {
    navigator.getBattery().then((b) => {
      const check = () => {
        allowWake = b.charging || b.level > 0.3;
        if (!allowWake && wakeLock) { wakeLock.release(); wakeLock = null; } else keepAwake();
      };
      b.addEventListener("chargingchange", check);
      b.addEventListener("levelchange", check);
      check();
    }).catch(() => {});
  }

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  applyLayout();
  setLyrics(lyr);
  keepAwake();
  connect();
  tickClock();
  window.pixelDeckStarted = true;  // seen by the watchdog in index.html
})();
