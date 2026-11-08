// PixelDeck — Music screen
// Renders synced lyrics (LRCLIB) and audio spectrum visualizer.
(function () {
  "use strict";
  const { $, txt, esc } = PD;

  // ---------- synced lyrics (LRCLIB, via the agent) ----------
  const LYR_MSG = {
    idle: "nothing playing", searching: "looking for lyrics…", none: "no lyrics found",
    instrumental: "♪ instrumental ♪", unsynced: "lyrics aren't time-synced", error: "lyrics unavailable (offline?)",
  };
  const LYR_TAG = { ok: "LRCLIB", searching: "SEARCHING", none: "NOT FOUND", instrumental: "INSTRUMENTAL", unsynced: "NOT SYNCED", error: "OFFLINE" };
  let lyr = { status: "idle", lines: [] };

  function setLyrics(m) {
    lyr = m;
    PD.lyrIdx = -2;
    const ok = m.status === "ok" && m.lines && m.lines.length;
    $("lyr").innerHTML = ok
      ? `<div class="lyr-list">${m.lines.map(([, t]) => `<p>${esc(t || "♪")}</p>`).join("")}</div>`
      : `<div class="lyr-msg">${esc(LYR_MSG[m.status] || "")}</div>`;
    txt("lyrState", LYR_TAG[m.status] || "--");
    txt("muTitle", m.title || "nothing playing");
    txt("muArtist", m.artist || "\u00a0");
  }

  function updateLyrics() {
    if (lyr.status !== "ok") return;
    const L = lyr.lines, t = PD.playPos() + 0.2;  // a hair early reads better than late
    let i = -1, lo = 0, hi = L.length - 1;         // last line that has started
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (L[mid][0] <= t) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    if (i === PD.lyrIdx) return;
    PD.lyrIdx = i;
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

  // ---------- visualizer (spectrum of the PC's sound, ~30 frames/s) ----------
  const VIZ_ROWS = 14;
  function drawViz(dt, nowMs) {
    const cv = $("viz"), ctx = cv.getContext("2d");
    const r = cv.getBoundingClientRect();
    const w = Math.round(r.width * devicePixelRatio), h = Math.round(r.height * devicePixelRatio);
    if (!w || !h) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const viz = PD.viz;
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
    if (PD.page() !== "music" || PD.saverOn()) return;
    const dt = lastFrame ? Math.min(0.1, (ts - lastFrame) / 1000) : 0;
    lastFrame = ts;
    updateLyrics();
    drawViz(dt, ts);
    musicRaf = requestAnimationFrame(musicFrame);
  }

  function startMusic() {
    if (!musicRaf && PD.page() === "music" && !PD.saverOn()) {
      lastFrame = 0;
      musicRaf = requestAnimationFrame(musicFrame);
    }
  }

  // ---------- register on the PD namespace ----------
  PD.setLyrics = setLyrics;
  PD.startMusic = startMusic;
})();
