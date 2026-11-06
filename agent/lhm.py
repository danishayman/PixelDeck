"""Reads CPU temperature/power/clock from LibreHardwareMonitor's WMI provider.

LibreHardwareMonitor must be running (as admin) for this to return data.
It publishes sensors to the local WMI namespace root\\LibreHardwareMonitor,
so nothing listens on the network.
"""
import logging
import threading
import time

log = logging.getLogger("lhm")


class LhmReader:
    def __init__(self, interval: float = 2.0):
        self.interval = interval
        self.data = None  # {"temp":..,"power":..,"clock":..}
        self.available = False
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="lhm", daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        try:
            import pythoncom
            import win32com.client
        except ImportError:
            log.warning("pywin32 not installed; CPU temperature disabled")
            return
        pythoncom.CoInitialize()
        wmi = None
        warned = False
        while not self._stop.is_set():
            try:
                if wmi is None:
                    wmi = win32com.client.GetObject(r"winmgmts:\\.\root\LibreHardwareMonitor")
                rows = wmi.ExecQuery(
                    "SELECT Name, SensorType, Value, Identifier FROM Sensor "
                    "WHERE SensorType='Temperature' OR SensorType='Power' OR SensorType='Clock'"
                )
                self.data = self._pick(rows)
                if not self.available:
                    log.info("LibreHardwareMonitor connected: %s", self.data)
                self.available = True
                warned = False
                self._stop.wait(self.interval)
            except Exception as e:
                wmi = None
                self.available = False
                self.data = None
                if not warned:
                    log.info("LibreHardwareMonitor not reachable (%s); retrying", str(e).splitlines()[0][:120])
                    warned = True
                self._stop.wait(15)

    @staticmethod
    def _pick(rows):
        temp_candidates = {}
        power = None
        clocks = []
        for r in rows:
            ident = str(r.Identifier or "")
            if not (ident.startswith("/amdcpu/") or ident.startswith("/intelcpu/")):
                continue
            name = str(r.Name or "")
            val = r.Value
            if val is None:
                continue
            kind = str(r.SensorType)
            if kind == "Temperature":
                temp_candidates[name] = float(val)
            elif kind == "Power" and name in ("Package", "CPU Package"):
                power = float(val)
            elif kind == "Clock" and name.startswith("Core #"):
                clocks.append(float(val))
        temp = None
        for pref in ("Core (Tctl/Tdie)", "CPU Package", "Core (Tctl)", "Tdie", "Core Max", "Core Average"):
            if pref in temp_candidates:
                temp = temp_candidates[pref]
                break
        if temp is None and temp_candidates:
            temp = max(temp_candidates.values())
        return {
            "temp": temp,
            "power": power,
            "clock": max(clocks) if clocks else None,
        }
