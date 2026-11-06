"""Internet check: pings a public address every 2 seconds.

Uses Windows' own ICMP API (IcmpSendEcho), so no admin rights and no ping.exe
window. If the first host doesn't answer, the other hosts are tried by ICMP and
by opening a TCP connection to port 443, so a network that only blocks ping
isn't reported as offline.
"""
import asyncio
import ctypes
import logging
import socket
import struct
import time
from collections import deque
from ctypes import wintypes

log = logging.getLogger("ping")

INTERVAL = 2.0      # seconds between checks
ICMP_TIMEOUT_MS = 1000
TCP_TIMEOUT = 1.5
OFFLINE_AFTER = 3   # failed checks in a row before showing "offline" (about 6 s)
LOSS_WINDOW = 30    # checks the packet-loss figure covers (about 1 minute)
LOSS_MIN = 15       # checks needed before loss is judged at all
LOSS_WARN = 10      # % loss that turns the ping tag orange...
LOSS_MISSES = 3     # ...and only with at least this many misses: one or two are blips

_iphlp = ctypes.WinDLL("iphlpapi", use_last_error=True)
_iphlp.IcmpCreateFile.restype = wintypes.HANDLE
_iphlp.IcmpCloseHandle.argtypes = [wintypes.HANDLE]
_iphlp.IcmpSendEcho.restype = wintypes.DWORD
_iphlp.IcmpSendEcho.argtypes = [
    wintypes.HANDLE, wintypes.ULONG, ctypes.c_void_p, wintypes.WORD,
    ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
]
_INVALID_HANDLE = ctypes.c_void_p(-1).value


def icmp_rtt(host: str, timeout_ms: int = ICMP_TIMEOUT_MS) -> int | None:
    """Round-trip time in ms of one ICMP echo to host, or None if nothing came back."""
    try:
        addr = socket.gethostbyname(host)
    except OSError:
        return None
    dest = int.from_bytes(socket.inet_aton(addr), "little")  # IPAddr: network byte order
    handle = _iphlp.IcmpCreateFile()
    if not handle or handle == _INVALID_HANDLE:
        return None
    try:
        payload = ctypes.create_string_buffer(b"pixeldeck", 32)
        reply = ctypes.create_string_buffer(256)
        if not _iphlp.IcmpSendEcho(handle, dest, payload, len(payload), None, reply, len(reply), timeout_ms):
            return None
        # ICMP_ECHO_REPLY starts with Address, Status, RoundTripTime (3 x ULONG)
        _addr, status, rtt = struct.unpack_from("<III", reply.raw, 0)
        return rtt if status == 0 else None
    finally:
        _iphlp.IcmpCloseHandle(handle)


async def tcp_rtt(host: str, port: int = 443, timeout: float = TCP_TIMEOUT) -> int | None:
    """Time in ms to open a TCP connection, or None if it couldn't be opened."""
    t0 = time.perf_counter()
    try:
        _reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
    except (OSError, asyncio.TimeoutError):
        return None
    rtt = round((time.perf_counter() - t0) * 1000)
    writer.close()
    return rtt


def _fmt(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    return f"{m}m {s:02d}s" if m < 60 else f"{m // 60}h {m % 60:02d}m"


class Ping:
    def __init__(self, cfg: dict):
        p = cfg.get("ping") or {}
        self.hosts = [str(h) for h in (p.get("hosts") or [])]
        self.warn_ms = float(p.get("warn_ms") or 100)
        self.fails = 0              # failed checks in a row
        self.fail_since = None      # time.time() of the first of them
        self.lost = deque(maxlen=LOSS_WINDOW)  # per online check: did the first host miss?
        self.recent = deque(maxlen=5)          # last few round-trip times
        # None = no result yet; "off" = no hosts configured
        self.state = None if self.hosts else {"level": "off"}

    async def check(self) -> tuple[int | None, bool]:
        """(round-trip ms or None, whether the first host answered ICMP)."""
        rtt = await asyncio.to_thread(icmp_rtt, self.hosts[0])
        if rtt is not None:
            return rtt, True
        tries = [asyncio.to_thread(icmp_rtt, h) for h in self.hosts[1:]]
        tries += [tcp_rtt(h) for h in self.hosts]
        answers = [r for r in await asyncio.gather(*tries) if r is not None]
        return (min(answers) if answers else None), False

    async def loop(self):
        if not self.hosts:
            return
        while True:
            t0 = time.monotonic()
            try:
                self.update(*await self.check())
            except Exception:
                log.exception("ping check")
            await asyncio.sleep(max(0.5, INTERVAL - (time.monotonic() - t0)))

    def update(self, rtt: int | None, first_ok: bool):
        now = time.time()
        if rtt is None:
            if self.fails == 0:
                self.fail_since = now
            self.fails += 1
            if self.fails == OFFLINE_AFTER:
                log.warning("internet offline: no reply from %s", ", ".join(self.hosts))
        else:
            if self.fails >= OFFLINE_AFTER:
                log.info("internet back after %s", _fmt(now - self.fail_since))
            self.fails = 0
            self.recent.append(rtt)
            # Loss only counts while the connection is up, so an outage doesn't leave
            # a minute of "loss" behind it.
            self.lost.append(not first_ok)

        # If the first host never answers ICMP while others do, ping is being
        # blocked rather than lost: don't report that as loss.
        # "loss" is only sent when it's worth showing: LOSS_WARN % or more over a full enough window.
        loss = None
        misses = sum(self.lost)
        if len(self.lost) >= LOSS_MIN and not all(self.lost) and misses >= LOSS_MISSES:
            pct = round(100 * misses / len(self.lost))
            loss = pct if pct >= LOSS_WARN else None

        # "Slow" goes by the median of the last few pings, so one spike doesn't flash orange.
        typical = sorted(self.recent)[len(self.recent) // 2] if self.recent else 0
        if self.fails >= OFFLINE_AFTER:
            level = "offline"
        elif self.fails or typical >= self.warn_ms or loss:
            level = "warn"
        else:
            level = "ok"
        self.state = {
            "level": level,
            "ms": rtt,
            "loss": loss,
            "down_since": self.fail_since if level == "offline" else None,
        }
