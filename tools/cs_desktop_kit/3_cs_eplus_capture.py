"""
ClimateStudio EnergyPlus capture (desktop session 1, step 1)

Copies the temporary EnergyPlus files ClimateStudio writes during a thermal
simulation, before they are cleaned up, then summarizes the input file.

Standard library only (Python 3.8+). Rhino 8 ships a Python you can use:
    %USERPROFILE%\\.rhinocode\\py39-rh8\\python.exe

Usage (run in a Command Prompt or PowerShell window, NOT inside Rhino):
    python 3_cs_eplus_capture.py
    python 3_cs_eplus_capture.py --model "C:\\path\\to\\model.3dm"
    python 3_cs_eplus_capture.py --roots "D:\\some\\folder" "E:\\other"
    python 3_cs_eplus_capture.py --summarize "C:\\path\\to\\in.idf"

Wait for "READY", run the ClimateStudio simulation, wait until it has
finished and results show, then press Ctrl+C. Everything is saved to
Desktop\\cs_capture_<timestamp> unless --out is given.

How it finds the files (all three run together):
  1. Windows file-system events on the watched folders (instant).
  2. Every new process is logged with its command line; an EnergyPlus
     command line names its input file and output folder directly.
  3. A polling scan of the watched folders, as a backup.
Any folder that contains EnergyPlus-looking files becomes "hot" and is
copied repeatedly while it changes, so the final versions are kept.
"""

import argparse
import datetime
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time

IS_WIN = os.name == "nt"

INTERESTING_EXT = {
    ".idf", ".epjson", ".imf", ".epw", ".err", ".eso", ".sql", ".rdd", ".mdd",
    ".audit", ".bnd", ".eio", ".mtr", ".mtd", ".shd", ".csr", ".expidf", ".rvaudit",
}
INTERESTING_NAMES = re.compile(r"(eplus|energyplus|in\.idf|in\.epw|sqlite\.err)", re.I)
PROC_HINT = re.compile(r"(energyplus|eplus|expandobjects|climatestudio|solemma)", re.I)
NOISY_PARTS = {"google", "mozilla", "packages", "crashdumps", "d3dscache", "spotify",
               "slack", "npm-cache", "pip", "nvidia", "onedrive", "windowsapps"}
MAX_COPY_BYTES = 500 * 1024 * 1024


def now():
    return datetime.datetime.now().strftime("%H:%M:%S")


def is_interesting(path):
    name = os.path.basename(path)
    ext = os.path.splitext(name)[1].lower()
    return ext in INTERESTING_EXT or bool(INTERESTING_NAMES.search(name))


def is_noisy(path):
    parts = {p.lower() for p in re.split(r"[\\/]", path)}
    return bool(parts & NOISY_PARTS)


def default_roots():
    roots = []
    for var in ("TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA"):
        v = os.environ.get(var)
        if v:
            roots.append(v)
    home = os.path.expanduser("~")
    roots.append(os.path.join(home, "Documents"))
    roots.append(os.path.join(home, "Desktop"))
    if not IS_WIN:
        roots.append("/tmp")
    out, seen = [], set()
    for r in roots:
        r = os.path.normpath(r)
        if os.path.isdir(r) and r.lower() not in seen:
            seen.add(r.lower())
            out.append(r)
    return out


class Capture:
    def __init__(self, out_dir, roots):
        self.out_dir = out_dir
        self.roots = roots
        self.files_dir = os.path.join(out_dir, "files")
        os.makedirs(self.files_dir, exist_ok=True)
        self.log_path = os.path.join(out_dir, "capture_log.txt")
        self.proc_path = os.path.join(out_dir, "processes.jsonl")
        self.hot = {}            # dir -> time marked
        self.copied = {}         # src path -> (size, mtime, dest)
        self.dir_mtimes = {}     # polling index
        self.eplus_procs = []
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.events = queue.Queue()

    # ---------- logging ----------
    def log(self, msg, echo=True):
        line = "{0}  {1}".format(now(), msg)
        with self.lock:
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        if echo:
            print(line, flush=True)

    # ---------- copying ----------
    def dest_for(self, src):
        drive, rest = os.path.splitdrive(os.path.abspath(src))
        rest = rest.lstrip("\\/")
        tag = drive.replace(":", "") or "root"
        return os.path.join(self.files_dir, tag, rest)

    def copy_file(self, src):
        try:
            st = os.stat(src)
        except OSError:
            return False
        if st.st_size > MAX_COPY_BYTES:
            return False
        sig = (st.st_size, st.st_mtime)
        prev = self.copied.get(src)
        if prev and prev[:2] == sig:
            return False
        dest = self.dest_for(src)
        try:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copy2(src, dest)
        except (OSError, shutil.Error):
            return False          # locked or vanished; retry on the next poll
        first = prev is None
        self.copied[src] = (st.st_size, st.st_mtime, dest)
        if first:
            self.log("copied  {0}".format(src))
        return True

    def mark_hot(self, d, why):
        d = os.path.normpath(d)
        if d.startswith(os.path.normpath(self.out_dir)):
            return
        if d not in self.hot:
            self.hot[d] = time.time()
            self.log("watching folder ({0}): {1}".format(why, d))
            self.sweep_hot(d)

    def sweep_hot(self, d):
        try:
            entries = list(os.scandir(d))
        except OSError:
            return
        for e in entries:
            try:
                if e.is_file(follow_symlinks=False):
                    self.copy_file(e.path)
                elif e.is_dir(follow_symlinks=False) and is_interesting_dir(e.path):
                    self.mark_hot(e.path, "subfolder")
            except OSError:
                pass

    # ---------- source 1: Windows file-system events + processes ----------
    def start_powershell(self):
        if not IS_WIN:
            return None
        roots_ps = ",".join("'" + r.replace("'", "''") + "'" for r in self.roots)
        script = r"""
$ErrorActionPreference = 'SilentlyContinue'
$roots = @(%ROOTS%)
$i = 0
foreach ($r in $roots) {
  if (Test-Path $r) {
    $w = New-Object System.IO.FileSystemWatcher $r
    $w.IncludeSubdirectories = $true
    $w.InternalBufferSize = 65536
    $w.NotifyFilter = [System.IO.NotifyFilters]'FileName, DirectoryName, LastWrite, Size'
    Register-ObjectEvent $w Created -SourceIdentifier ("c" + $i) | Out-Null
    Register-ObjectEvent $w Changed -SourceIdentifier ("m" + $i) | Out-Null
    Register-ObjectEvent $w Renamed -SourceIdentifier ("r" + $i) | Out-Null
    $w.EnableRaisingEvents = $true
    $i++
  }
}
$known = @{}
Get-CimInstance Win32_Process | ForEach-Object { $known[[string]$_.ProcessId] = 1 }
[Console]::Out.WriteLine("READY`t" + $i)
[Console]::Out.Flush()
while ($true) {
  $e = Wait-Event -Timeout 0.5
  while ($e) {
    [Console]::Out.WriteLine("FS`t" + $e.SourceEventArgs.ChangeType + "`t" + $e.SourceEventArgs.FullPath)
    Remove-Event -EventIdentifier $e.EventIdentifier
    $e = Get-Event | Select-Object -First 1
  }
  Get-CimInstance Win32_Process | ForEach-Object {
    $k = [string]$_.ProcessId
    if (-not $known.ContainsKey($k)) {
      $known[$k] = 1
      $o = [ordered]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; exe = $_.ExecutablePath; cmd = $_.CommandLine }
      [Console]::Out.WriteLine("PROC`t" + ($o | ConvertTo-Json -Compress))
    }
  }
  [Console]::Out.Flush()
}
""".replace("%ROOTS%", roots_ps)
        try:
            proc = subprocess.Popen(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                encoding="utf-8", errors="replace", bufsize=1)
        except OSError as ex:
            self.log("PowerShell not available ({0}); using polling only".format(ex))
            return None

        def reader():
            for line in proc.stdout:
                if self.stop.is_set():
                    break
                self.events.put(line.rstrip("\r\n"))

        threading.Thread(target=reader, daemon=True).start()
        return proc

    def handle_event(self, line):
        parts = line.split("\t", 2)
        if parts[0] == "READY":
            self.log("file watchers active on {0} folder(s)".format(parts[1] if len(parts) > 1 else "?"))
            self.ps_ready = True
        elif parts[0] == "FS" and len(parts) == 3:
            path = parts[2]
            if is_noisy(path) or path.startswith(self.out_dir):
                return
            if is_interesting(path):
                self.mark_hot(os.path.dirname(path), "new EnergyPlus-type file")
                self.copy_file(path)
        elif parts[0] == "PROC" and len(parts) >= 2:
            try:
                info = json.loads(parts[1])
            except ValueError:
                return
            with open(self.proc_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(dict(info, seen=now())) + "\n")
            blob = " ".join(str(info.get(k) or "") for k in ("name", "exe", "cmd"))
            if PROC_HINT.search(blob):
                self.log("process started: {0}  pid {1}\n          exe: {2}\n          cmd: {3}".format(
                    info.get("name"), info.get("pid"), info.get("exe"), info.get("cmd")))
                self.eplus_procs.append(info)
                for p in paths_in_command(info.get("cmd") or ""):
                    self.mark_hot(p if os.path.isdir(p) else os.path.dirname(p), "named on a command line")

    # ---------- source 3: polling ----------
    def index(self):
        count = 0
        for root in self.roots:
            for d in walk_dirs(root):
                if d.startswith(self.out_dir):
                    continue
                try:
                    self.dir_mtimes[d] = os.stat(d).st_mtime
                    count += 1
                except OSError:
                    pass
        return count

    def poll_once(self):
        for d, old in list(self.dir_mtimes.items()):
            try:
                m = os.stat(d).st_mtime
            except OSError:
                self.dir_mtimes.pop(d, None)
                continue
            if m == old:
                continue
            self.dir_mtimes[d] = m
            self.scan_new(d)

    def scan_new(self, d):
        try:
            entries = list(os.scandir(d))
        except OSError:
            return
        for e in entries:
            try:
                if e.is_dir(follow_symlinks=False):
                    if e.path not in self.dir_mtimes and not is_noisy(e.path) \
                            and not e.path.startswith(self.out_dir):
                        self.dir_mtimes[e.path] = e.stat().st_mtime
                        self.scan_new(e.path)
                elif e.is_file(follow_symlinks=False) and is_interesting(e.path):
                    self.mark_hot(d, "found by scan")
            except OSError:
                pass

    # ---------- main loop ----------
    def run(self):
        self.ps_ready = False
        self.log("output folder: {0}".format(self.out_dir))
        for r in self.roots:
            self.log("watching: {0}".format(r))
        ps = self.start_powershell()
        self.log("indexing folders for the backup scan (can take a minute)...")
        n = self.index()
        self.log("indexed {0} folders".format(n))
        if ps is not None:
            t0 = time.time()
            while not self.ps_ready and time.time() - t0 < 60:
                try:
                    self.handle_event(self.events.get(timeout=0.5))
                except queue.Empty:
                    pass
        print("\nREADY. Start the ClimateStudio simulation now. Press Ctrl+C when it has finished.\n", flush=True)

        last_poll = 0.0
        try:
            while not self.stop.is_set():
                deadline = time.time() + 0.25
                while time.time() < deadline:
                    try:
                        self.handle_event(self.events.get(timeout=0.05))
                    except queue.Empty:
                        pass
                for d in list(self.hot):
                    self.sweep_hot(d)
                if time.time() - last_poll > 1.5:
                    self.poll_once()
                    last_poll = time.time()
        except KeyboardInterrupt:
            pass
        finally:
            self.stop.set()
            if ps is not None:
                try:
                    ps.terminate()
                except OSError:
                    pass
            for d in list(self.hot):
                self.sweep_hot(d)
            self.finish()

    def finish(self):
        inputs = [v[2] for k, v in self.copied.items()
                  if os.path.splitext(k)[1].lower() in (".idf", ".epjson", ".imf", ".expidf")]
        lines = ["# ClimateStudio EnergyPlus capture", "",
                 "Finished {0}.".format(datetime.datetime.now().isoformat()), "",
                 "## EnergyPlus-related processes", ""]
        if self.eplus_procs:
            for p in self.eplus_procs:
                lines += ["- **{0}** (pid {1})".format(p.get("name"), p.get("pid")),
                          "  - exe: `{0}`".format(p.get("exe")),
                          "  - command line: `{0}`".format(p.get("cmd"))]
        else:
            lines.append("None seen. (On Windows this list comes from the process log; "
                         "see processes.jsonl for every process that started.)")
        lines += ["", "## Folders watched because they held EnergyPlus files", ""]
        lines += ["- `{0}`".format(d) for d in self.hot] or ["None."]
        lines += ["", "## Files copied ({0})".format(len(self.copied)), ""]
        for src, (size, _, dest) in sorted(self.copied.items()):
            lines.append("- `{0}` ({1:,} bytes)".format(src, size))
        lines += ["", "## Input files summarized", ""]
        for p in inputs:
            try:
                out = summarize(p, self.out_dir)
                lines.append("- `{0}` -> `{1}`".format(p, out))
            except Exception as ex:
                lines.append("- `{0}`: could not summarize ({1})".format(p, ex))
        if not inputs:
            lines.append("No .idf or .epJSON captured. See the guide's troubleshooting section.")
        path = os.path.join(self.out_dir, "SUMMARY.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        self.log("summary written: {0}".format(path))
        self.log("captured {0} file(s); {1} input file(s)".format(len(self.copied), len(inputs)))


def is_interesting_dir(path):
    name = os.path.basename(path).lower()
    return "eplus" in name or "energyplus" in name or "cs" == name


def walk_dirs(root):
    stack = [root]
    while stack:
        d = stack.pop()
        if is_noisy(d):
            continue
        yield d
        try:
            for e in os.scandir(d):
                try:
                    if e.is_dir(follow_symlinks=False):
                        stack.append(e.path)
                except OSError:
                    pass
        except OSError:
            pass


def paths_in_command(cmd):
    """Return existing file or folder paths mentioned on a command line."""
    found = []
    for tok in re.findall(r'"([^"]+)"|(\S+)', cmd):
        t = (tok[0] or tok[1]).strip()
        if len(t) < 3 or t.startswith("-"):
            continue
        if os.path.exists(t):
            found.append(os.path.abspath(t))
    return found


# ---------------- input file summary ----------------

KEY_CLASSES = [
    ("Version", 1), ("Timestep", 1), ("SimulationControl", 1), ("Building", 1),
    ("RunPeriod", 2), ("Site:Location", 1), ("Site:WeatherStation", 1),
    ("Site:HeightVariation", 1), ("Site:GroundTemperature", 2),
    ("HeatBalanceAlgorithm", 1), ("SurfaceConvectionAlgorithm", 2), ("ShadowCalculation", 1),
    ("ZoneVentilation:", 20), ("ZoneInfiltration:", 5), ("ZoneMixing", 5), ("ZoneCrossMixing", 5),
    ("ZoneAirContaminantBalance", 2), ("ZoneContaminantSourceAndSink", 5),
    ("OutdoorAir:", 3), ("People", 5), ("Lights", 2), ("ElectricEquipment", 2),
    ("AirflowNetwork:", 40), ("ZoneHVAC:IdealLoadsAirSystem", 2),
    ("HVACTemplate:Zone:IdealLoadsAirSystem", 2), ("ZoneControl:Thermostat", 2),
    ("AvailabilityManager", 3), ("EnergyManagementSystem:", 10),
    ("WindowMaterial:SimpleGlazingSystem", 3), ("WindowMaterial:Glazing", 3),
    ("Material", 5), ("Material:NoMass", 3), ("Construction", 8),
    ("Zone", 5), ("BuildingSurface:Detailed", 4), ("FenestrationSurface:Detailed", 4),
    ("Schedule:Compact", 3), ("Schedule:File", 3), ("Schedule:Year", 2), ("Output:Variable", 60),
]


def parse_idf(text):
    """Return a list of (class, [(value, field_comment), ...])."""
    objects, fields, buf = [], [], []
    for raw in text.splitlines():
        comment = ""
        if "!-" in raw:
            raw, comment = raw.split("!-", 1)
        elif "!" in raw:
            raw = raw.split("!", 1)[0]
        comment = comment.strip()
        line = raw.strip()
        if not line:
            continue
        i = 0
        for ch in line:
            if ch in ",;":
                fields.append(("".join(buf).strip(), ""))
                buf = []
                if ch == ";":
                    if fields:
                        fields[-1] = (fields[-1][0], comment)
                        objects.append((fields[0][0], fields[1:]))
                    fields = []
            else:
                buf.append(ch)
            i += 1
        if fields:
            fields[-1] = (fields[-1][0], comment)
    return objects


def summarize(path, out_dir):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    base = os.path.basename(path)
    lines = ["# Summary of {0}".format(base), "", "Source: `{0}`".format(path), ""]
    if path.lower().endswith(".epjson"):
        data = json.loads(text)
        counts = {k: len(v) if isinstance(v, dict) else 1 for k, v in data.items()}
        lines += ["## Object counts", "", "| Class | Count |", "| --- | --- |"]
        lines += ["| {0} | {1} |".format(k, counts[k]) for k in sorted(counts)]
        lines += ["", "## Key objects", ""]
        for prefix, n in KEY_CLASSES:
            for cls in sorted(k for k in data if k == prefix or (prefix.endswith(":") and k.startswith(prefix))):
                items = list(data[cls].items())[:n] if isinstance(data[cls], dict) else [(cls, data[cls])]
                lines.append("### {0} ({1})".format(cls, counts.get(cls)))
                lines.append("```json")
                lines.append(json.dumps(dict(items), indent=2)[:20000])
                lines.append("```")
    else:
        objs = parse_idf(text)
        counts = {}
        for cls, _ in objs:
            counts[cls] = counts.get(cls, 0) + 1
        lines += ["## Object counts ({0} objects)".format(len(objs)), "",
                  "| Class | Count |", "| --- | --- |"]
        lines += ["| {0} | {1} |".format(k, counts[k]) for k in sorted(counts, key=str.lower)]
        lines += ["", "## Key objects", ""]
        lower = [(c.lower(), c) for c in counts]
        for prefix, n in KEY_CLASSES:
            pl = prefix.lower()
            for _, cls in sorted(l for l in lower if l[0] == pl or (pl.endswith(":") and l[0].startswith(pl))
                                 or (pl.endswith("availabilitymanager") and l[0].startswith(pl))):
                shown = [o for o in objs if o[0] == cls][:n]
                lines.append("### {0} ({1} total, {2} shown)".format(cls, counts[cls], len(shown)))
                lines.append("```")
                for _, fields in shown:
                    lines.append(cls + ",")
                    for k, (val, note) in enumerate(fields):
                        end = ";" if k == len(fields) - 1 else ","
                        lines.append("    {0}{1}{2}".format(val, end, ("  !- " + note) if note else ""))
                    lines.append("")
                lines.append("```")
    target = os.path.join(out_dir, "summary_{0}.md".format(re.sub(r"[^\w.-]", "_", base)))
    with open(target, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return target


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", help="output folder (default: Desktop\\cs_capture_<timestamp>)")
    ap.add_argument("--roots", nargs="*", help="folders to watch (default: TEMP, AppData, ProgramData, Documents, Desktop)")
    ap.add_argument("--model", help="the Rhino model file; its folder is watched too")
    ap.add_argument("--summarize", help="only summarize an existing .idf or .epJSON and exit")
    args = ap.parse_args()

    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    out = args.out or os.path.join(os.path.expanduser("~"), "Desktop", "cs_capture_" + stamp)
    os.makedirs(out, exist_ok=True)

    if args.summarize:
        print(summarize(args.summarize, out))
        return

    roots = args.roots if args.roots else default_roots()
    if args.model:
        roots.append(os.path.dirname(os.path.abspath(args.model)))
    roots = [os.path.normpath(r) for r in roots if os.path.isdir(r)]
    Capture(out, roots).run()


if __name__ == "__main__":
    main()
