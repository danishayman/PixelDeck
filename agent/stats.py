"""CPU / RAM / disk / network via psutil, GPU via NVIDIA NVML."""
import logging
import time

import psutil

log = logging.getLogger("stats")

try:
    import pynvml
except ImportError:  # pragma: no cover
    pynvml = None


class Gpu:
    def __init__(self):
        self.handle = None
        self.name = None
        if pynvml is None:
            return
        try:
            pynvml.nvmlInit()
            self.handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            name = pynvml.nvmlDeviceGetName(self.handle)
            self.name = name.decode() if isinstance(name, bytes) else name
            log.info("GPU: %s", self.name)
        except Exception as e:
            log.warning("NVML unavailable: %s", e)
            self.handle = None

    def sample(self):
        if self.handle is None:
            return None
        h = self.handle
        out = {"name": self.name}
        try:
            out["util"] = pynvml.nvmlDeviceGetUtilizationRates(h).gpu
            mem = pynvml.nvmlDeviceGetMemoryInfo(h)
            out["mem_used"] = mem.used
            out["mem_total"] = mem.total
            out["temp"] = pynvml.nvmlDeviceGetTemperature(h, pynvml.NVML_TEMPERATURE_GPU)
        except Exception as e:
            log.debug("NVML read failed: %s", e)
            return None
        for key, fn in (
            ("power", lambda: pynvml.nvmlDeviceGetPowerUsage(h) / 1000.0),
            ("fan", lambda: pynvml.nvmlDeviceGetFanSpeed(h)),
            ("clock", lambda: pynvml.nvmlDeviceGetClockInfo(h, pynvml.NVML_CLOCK_GRAPHICS)),
        ):
            try:
                out[key] = fn()
            except Exception:
                out[key] = None
        return out


class Stats:
    def __init__(self):
        psutil.cpu_percent(None)
        psutil.cpu_percent(None, percpu=True)
        self.gpu = Gpu()
        self._t = time.monotonic()
        self._net = psutil.net_io_counters()
        self._disk = psutil.disk_io_counters()
        self._drives = []
        self._drives_t = 0.0
        self._top = None
        self._top_t = 0.0
        self._ncpu = psutil.cpu_count() or 1
        self.boot = psutil.boot_time()

    def _top_app(self):
        """Busiest app by CPU, summed across its processes (refreshed every 3 s)."""
        now = time.monotonic()
        if now - self._top_t < 3:
            return self._top
        self._top_t = now
        totals = {}
        for p in psutil.process_iter(["name"]):
            if p.pid in (0, 4):  # System Idle Process, System
                continue
            try:
                pct = p.cpu_percent(None)  # psutil caches Process objects between calls
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
            name = (p.info.get("name") or "").removesuffix(".exe")
            if name:
                totals[name] = totals.get(name, 0.0) + pct
        if totals:
            name, pct = max(totals.items(), key=lambda kv: kv[1])
            self._top = {"name": name, "pct": pct / self._ncpu}
        return self._top

    def _drive_list(self):
        # Refresh drive free space every 30 s; it barely changes.
        now = time.monotonic()
        if now - self._drives_t > 30 or not self._drives:
            drives = []
            for p in psutil.disk_partitions(all=False):
                if "fixed" not in p.opts and "rw" not in p.opts:
                    continue
                try:
                    u = psutil.disk_usage(p.mountpoint)
                except (PermissionError, OSError):
                    continue
                drives.append({"name": p.mountpoint.rstrip("\\"), "free": u.free, "total": u.total})
            self._drives = drives
            self._drives_t = now
        return self._drives

    def sample(self) -> dict:
        now = time.monotonic()
        dt = max(now - self._t, 1e-3)
        net = psutil.net_io_counters()
        disk = psutil.disk_io_counters()
        rx = (net.bytes_recv - self._net.bytes_recv) / dt
        tx = (net.bytes_sent - self._net.bytes_sent) / dt
        rd = wr = 0.0
        if disk and self._disk:
            rd = (disk.read_bytes - self._disk.read_bytes) / dt
            wr = (disk.write_bytes - self._disk.write_bytes) / dt
        self._t, self._net, self._disk = now, net, disk

        vm = psutil.virtual_memory()
        return {
            "cpu": {
                "util": psutil.cpu_percent(None),
                "cores": psutil.cpu_percent(None, percpu=True),
                "top": self._top_app(),
            },
            "ram": {"used": vm.total - vm.available, "total": vm.total, "pct": vm.percent},
            "gpu": self.gpu.sample(),
            "net": {"rx": max(rx, 0), "tx": max(tx, 0)},
            "disk": {"read": max(rd, 0), "write": max(wr, 0), "drives": self._drive_list()},
            "uptime": time.time() - self.boot,
        }
