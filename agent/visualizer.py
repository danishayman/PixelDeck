"""Audio spectrum of whatever the PC is playing, for the music page's visualizer.

Records the default speaker's output through WASAPI loopback (SoundCard), runs
an FFT and boils it down to BANDS bar heights (0-100). Capture only runs while a
screen is showing the music page.
"""
import logging
import threading
import time

import numpy as np

log = logging.getLogger("viz")

BANDS = 32
RATE = 48000
BLOCK = 1024             # frames per read: ~47 analyses a second
FFT = 2048
FMIN, FMAX = 40, 16000   # Hz covered by the bars, spaced evenly in octaves
TILT_DB = 3.0            # dB boost per octave, so treble isn't dwarfed by bass
RANGE_DB = 40            # loudness span from an empty bar to a full one (smaller = punchier bars)


class Visualizer:
    def __init__(self):
        self.levels = [0] * BANDS  # latest bar heights, 0-100
        self.seq = 0               # goes up with each new frame
        self._want = threading.Event()
        self._thread = None
        freqs = np.fft.rfftfreq(FFT, 1 / RATE)
        edges = np.geomspace(FMIN, FMAX, BANDS + 1)
        self._bins = []
        for lo, hi in zip(edges[:-1], edges[1:]):
            i0 = int(np.searchsorted(freqs, lo))
            self._bins.append((i0, max(i0 + 1, int(np.searchsorted(freqs, hi)))))
        centres = np.sqrt(edges[:-1] * edges[1:])
        self._tilt = TILT_DB * np.log2(centres / FMIN)
        self._window = np.hanning(FFT).astype(np.float32)
        self._ref = -30.0  # loudest recent band (dB); bars are scaled to it, like auto-gain

    def set_active(self, on: bool):
        if on:
            self._want.set()
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, name="visualizer", daemon=True)
                self._thread.start()
        else:
            self._want.clear()

    def _run(self):
        # Imported here: SoundCard sets up COM for the thread that imports it, and
        # every capture call then has to come from this same thread.
        import soundcard as sc
        import warnings
        warnings.filterwarnings("ignore", module="soundcard")  # "data discontinuity" after hiccups
        while True:
            self._want.wait()
            try:
                spk = sc.default_speaker()
                mic = sc.get_microphone(spk.id, include_loopback=True)
                log.info("visualizer: listening to %s", spk.name)
                buf = np.zeros(FFT, dtype=np.float32)
                checked = time.monotonic()
                with mic.recorder(samplerate=RATE, blocksize=BLOCK) as rec:
                    while self._want.is_set():
                        data = rec.record(numframes=BLOCK)
                        mono = data.mean(axis=1) if data.ndim > 1 else data
                        buf = np.concatenate((buf, mono))[-FFT:]
                        self._analyse(buf)
                        if time.monotonic() - checked > 5:  # output switched, e.g. to headphones?
                            checked = time.monotonic()
                            if sc.default_speaker().id != spk.id:
                                break
                self.levels = [0] * BANDS
                self.seq += 1
            except Exception as e:
                log.warning("visualizer capture failed: %r", e)
                time.sleep(3)

    def _analyse(self, buf: np.ndarray):
        spec = np.abs(np.fft.rfft(buf * self._window)) / (FFT / 4)  # full-scale sine ~ 0 dB
        db = 20 * np.log10(np.maximum(spec, 1e-9))
        bands = np.array([db[i0:i1].max() for i0, i1 in self._bins]) + self._tilt
        # Follow the loudest band: jump up at once, sink ~7 dB/s, never below -40 dB
        # (so silence stays dark instead of being turned up into noise).
        self._ref = max(bands.max(), self._ref - 0.15, -40.0)
        lv = np.clip((bands - (self._ref - RANGE_DB)) / RANGE_DB, 0, 1)
        self.levels = [int(x * 100) for x in lv]
        self.seq += 1
