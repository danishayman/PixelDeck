// PixelDeck — Clock / Main screen
// Renders clock, prayer times, calendar, weather, CPU, GPU, RAM, net, disk,
// ping, uptime, phone, media card, and album art.
(function () {
  "use strict";
  const { $, cfg, HIST, pad, gb, rate, rateShort, dur, uptime, heat,
          txt, html, each, fillSeg, drawSpark,
          hm, hhmmOf, is24, clockTxt,
          DAYS, DAYS_LONG, MONS,
          toast, send } = PD;

  const cpuHist = [], gpuHist = [];

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

  let lastHH = "--";
  function renderClock(d) {
    let h = d.getHours();
    const h24 = is24();
    const ampm = h < 12 ? "AM" : "PM";
    if (!h24) h = h % 12 || 12;
    const hh = h24 ? pad(h) : String(h);
    lastHH = hh;
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
  // Expose the current hour string for the saver clock.
  PD._hh = () => lastHH;

  // ---------- prayer times (JAKIM e-Solat, sent by the agent) ----------
  // [key the agent sends (JAKIM's Malay name), label shown]
  const SOLAT = [["subuh", "FAJR"], ["zohor", "DHUHR"], ["asar", "ASR"], ["maghrib", "MAGHRIB"], ["isyak", "ISHA"]];
  let solatKey = "", solatToasted = "";
  function renderSolat(d) {
    const sv = PD.last() && PD.last().solat;
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
      if (!PD.saverOn()) toast(`${arrived[1]} ${clockTxt(sv.today[arrived[0]])}`, false, 6000);
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
    const c = PD.last() && PD.last().calendar;
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
    if (!e || e.allday || PD.saverOn()) return;
    const mins = Math.ceil((e.start - now) / 60);
    const id = `${e.start}|${e.title}`;
    let k = "";
    if (c.remind && mins === c.remind) k = id + "|remind";
    else if (e.start <= now && now - e.start < 60) k = id + "|start";
    if (k && k !== evToasted) { evToasted = k; toast(r.text, false, 8000); }
  }

  // ---------- render stats ----------
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
      txt("wmetaBc", "\u00a0");
      each("walert", (e) => { e.hidden = true; });
      each("aqi", (e) => { e.hidden = true; });
      each("uv", (e) => { e.hidden = true; });
      txt("wmeta", "\u00a0");
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
    txt("wmetaBc", (a ? parts.slice(0, 1) : parts).join(" · ") || "\u00a0");
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
    if (soon && rainWasSoon === false && !PD.saverOn()) toast(alertTxt, false, 5000);
    rainWasSoon = soon;
  }

  function setPlayIcon(p) {
    if (p === PD.playing) return;
    PD.playing = p;
    document.querySelectorAll(".pbtn.play").forEach((b) => { b.innerHTML = Pixels.svg(p ? "pause" : "play"); });
  }

  function renderMedia(m, now) {
    const has = m && m.title;
    each("mediaCard", (card) => card.classList.toggle("idle", !has));
    PD.play.playing = !!(has && m.status === "playing");
    if (PD.play.playing) PD.play.lastPlaying = Date.now();
    if (has) {
      // m.pos was measured at m.pos_at (PC clock); add the time since, then count on locally.
      PD.play.pos = m.pos + (PD.play.playing && m.pos_at && now ? Math.max(0, now - m.pos_at) : 0);
      PD.play.at = performance.now();
    }
    if (!has) {
      txt("mtitle", "nothing playing");
      txt("martist", "\u00a0");
      txt("mtime", "");
      each("mediaApp", (e) => { e.hidden = true; });
      fillSeg("media", 0);
      setPlayIcon(false);
      return;
    }
    txt("mtitle", m.title);
    txt("martist", m.artist || m.album || "\u00a0");
    each("mediaApp", (e) => { e.hidden = !m.app; e.textContent = m.app || ""; });
    fillSeg("media", m.end ? m.pos / m.end : 0);
    txt("mtime", m.end ? `${dur(m.pos)}/${dur(m.end)}` : "");
    setPlayIcon(m.status === "playing");
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
    if (netLevel && level !== netLevel && !PD.saverOn()) {
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
    txt("drives", drives.map((d) => `${d.name} ${Math.round(d.free / 1073741824)}G free`).join(" · ") || "\u00a0");
    txt("drivesShort", drives.length ? drives.map((d) => `${d.name} ${Math.round(d.free / 1073741824)}G`).join(" · ") + " free" : "\u00a0");
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
    PD.renderAudio(s.audio);
  }

  // ---------- register on the PD namespace ----------
  PD.render = render;
  PD.renderClock = renderClock;
  PD.renderSolat = renderSolat;
  PD.renderCalendar = renderCalendar;
  PD.setPlayIcon = setPlayIcon;
  PD.setArt = setArt;
})();
