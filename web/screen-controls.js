// PixelDeck — Controls screen
// Renders volume, mute, mic state, app launcher grid, and handles volume slider interaction.
(function () {
  "use strict";
  const { $, txt, html, each, fillSeg, esc, buzz, send } = PD;

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

  // ---------- register on the PD namespace ----------
  PD.showVol = showVol;
  PD.renderAudio = renderAudio;
  PD.buildApps = buildApps;
})();
