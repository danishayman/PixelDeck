// PixelDeck core: shared state, utilities, layout/page management, WebSocket,
// saver, dim, input handling, and wake lock.
// Exposes window.PD for the per-screen modules.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const W = 880, H = 396, HIST = 48;
  const LAYOUTS = ["bigclock", "classic", "desk"];  // clock page styles
  const LAYOUT_NAMES = { bigclock: "BIG CLOCK", classic: "CLASSIC", desk: "DESK" };
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
    if (PD.resetInk) PD.resetInk();
    if (PD.renderClock) PD.renderClock(new Date());
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
    PD.lyrIdx = -2;  // lyric positions need measuring again once the page is visible
    if (p === "music") PD.startMusic();
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
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
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
  const hm = (t) => { const [h, m] = String(t).split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const hhmmOf = (t) => { const d = new Date(t * 1000); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
  function is24() { return use24 !== null ? use24 : !!cfg.clock_24h; }
  function clockTxt(t) {  // "13:04" -> "1:04" in 12-hour mode
    if (is24()) return t;
    const m = hm(t);
    return `${Math.floor(m / 60) % 12 || 12}:${pad(m % 60)}`;
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
      PD.startMusic();
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
        PD.render(m);
        updateSaver();
      } else if (m.t === "viz") {
        PD.viz.target = m.b || [];
        PD.viz.last = performance.now();
      } else if (m.t === "lyrics") {
        PD.setLyrics(m);
      } else if (m.t === "hello") {
        Object.assign(cfg, m.config || {});
        applyLayout();
        PD.buildApps(cfg.apps);
      } else if (m.t === "ack") {
        if (!m.ok) buzz("err");
        toast(m.msg, !m.ok);
        PD.renderAudio(m.audio);
      } else if (m.t === "art") {
        PD.setArt(m.data);
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
      if (b.dataset.action === "toggle") PD.setPlayIcon(!PD.playing);
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
      PD.renderClock(new Date());
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

  // Tell the agent which page this screen shows: it only sends visualizer frames to
  // screens on the music page, and only captures the PC's sound while there are some.
  function reportPage() {
    send({ cmd: "page", page: document.visibilityState !== "visible" ? "hidden" : saverOn ? "saver" : page });
  }
  document.addEventListener("visibilitychange", reportPage);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  // ---------- tick (the 1-second heartbeat) ----------
  function tickClock() {
    const d = new Date();
    PD.renderClock(d);
    PD.renderSolat(d);
    PD.renderCalendar(d);
    updateSaver();
    updateDim(d);
    maybeShift();
    if (page === "controls" && Date.now() - lastTouch > CONTROLS_TIMEOUT) setPage("main");
    if (page === "music") {
      const quiet = Date.now() - Math.max(lastTouch, PD.play.lastPlaying);
      if (!PD.play.playing && quiet > MUSIC_TIMEOUT) setPage("main");
      else PD.startMusic();  // no-op while already running
    }
    if (d.getSeconds() % 20 === 0) moveSaver();
    $("saverClock").textContent = `${PD._hh()}:${pad(d.getMinutes())}`;
    setTimeout(tickClock, 1000 - (Date.now() % 1000) + 5);
  }

  // ---------- public interface for screen modules ----------
  // The PD namespace is filled in by screen-*.js; core.js seeds the fields
  // that core itself needs to call.
  window.PD = {
    // --- refs for screen modules ---
    $, cfg, HIST, pad, esc, gb, rate, rateShort, dur, uptime, heat,
    txt, html, each, fillSeg, drawSpark,
    hm, hhmmOf, is24, clockTxt,
    DAYS, DAYS_LONG, MONS,
    toast, buzz, send, saverOn: () => saverOn,
    last: () => last,

    // --- media / play state (shared between clock + music screens) ---
    playing: null,
    play: { pos: 0, at: 0, playing: false, lastPlaying: 0 },
    playPos() { return this.play.pos + (this.play.playing ? (performance.now() - this.play.at) / 1000 : 0); },
    setPlayIcon: () => {},   // set by screen-clock.js
    setArt: () => {},        // set by screen-clock.js

    // --- lyrics / viz state (set by screen-music.js) ---
    lyrIdx: -2,
    viz: { target: [], shown: [], peak: [], peakAt: [], last: 0, colors: null },
    setLyrics: () => {},     // set by screen-music.js
    startMusic: () => {},    // set by screen-music.js

    // --- controls (set by screen-controls.js) ---
    renderAudio: () => {},   // set by screen-controls.js
    buildApps: () => {},     // set by screen-controls.js

    // --- clock (set by screen-clock.js) ---
    render: () => {},        // set by screen-clock.js
    renderClock: () => {},   // set by screen-clock.js
    renderSolat: () => {},   // set by screen-clock.js
    renderCalendar: () => {},// set by screen-clock.js

    // --- volume hold (shared between core input + controls) ---
    volHoldUntil: 0,

    // --- helpers for saver clock (the hour string, set by screen-clock) ---
    _hh: () => "--",

    // --- startup ---
    boot() {
      applyLayout();
      PD.setLyrics({ status: "idle", lines: [] });
      keepAwake();
      connect();
      tickClock();
      window.pixelDeckStarted = true;  // seen by the watchdog in index.html
    },

    // --- page state for screens ---
    page: () => page,
  };
})();
