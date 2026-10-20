"""EnergyPlus alignment test: re-run a ClimateStudio model and compare with ClimateStudio's results.

Runs EnergyPlus 23.1 on the .epJSON that ClimateStudio left in its results folder, unmodified,
with the weather file ClimateStudio used, then compares every hourly output with ClimateStudio's
.eso. Results go to runs/<case>/ inside the repository (ignored by Git).

    python tools/run_alignment.py example02
    python tools/run_alignment.py example02 --repeat     # also check two local runs are identical

EnergyPlus must run from an internal drive: it crashes at startup when started from the exFAT
project drive. If the EnergyPlus folder is missing, the files needed for a run are copied from
E:\\ARCH 540\\tools\\EnergyPlus-23.1.0 (about 120 MB). Needs only Python 3 (Rhino 8's works).
"""
import argparse, os, shutil, subprocess, sys, time
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compare_eso import read_eso, main as compare_table

REPO = Path(__file__).resolve().parents[1]
A2 = REPO.parent                    # course data folder, read-only
DRIVE_TOOLS = A2.parent / "tools"   # E:\ARCH 540\tools
EPLUS_BUILD = "23.1.0-87ed9199d4"   # the build ClimateStudio 2.2 used
DEFAULT_EPLUS = Path(os.environ.get("EPLUS_DIR", r"C:\EnergyPlus-23.1.0"))
WEATHER = A2 / "Weather Files" / "CAN_BC_Vancouver.Intl.AP.718920_TDY-CWEC2020v2.epw"

CASES = {
    "example02": A2 / "Example 02" / "Results" / "2226_Emmenweid.epJSON",
    "example01": A2 / "Example 01" / "CS Results" / "Willem_Girard_CS_V3.epJSON",
}

# Folders of the EnergyPlus distribution not needed to run a model or use its Python API.
SKIP_DIRS = {"ExampleFiles", "Documentation", "PreProcess", "PostProcess", "DataSets",
             "MacroDataSets", "WeatherData", "temp", "workflows"}

MAX_MEAN_DT = 0.05     # degC, mean |difference| in zone mean air temperature
MIN_WITHIN = 99.0      # percent of zone-hours within 0.5 degC
TEMP_VAR = "Zone Mean Air Temperature"


def ensure_energyplus(eplus_dir, source_dir):
    exe = eplus_dir / "energyplus.exe"
    if not exe.exists():
        if not (source_dir / "energyplus.exe").exists():
            sys.exit("EnergyPlus not found in %s or %s" % (eplus_dir, source_dir))
        print("Copying EnergyPlus from %s to %s ..." % (source_dir, eplus_dir))
        shutil.copytree(source_dir, eplus_dir,
                        ignore=lambda d, names: SKIP_DIRS & set(names) if Path(d) == source_dir else [])
    version = subprocess.run([str(exe), "--version"], capture_output=True, text=True)
    if version.returncode != 0:
        sys.exit("EnergyPlus failed to start (exit %d). It cannot run from an exFAT drive; "
                 "use a folder on an internal drive." % version.returncode)
    if EPLUS_BUILD not in version.stdout:
        sys.exit("Wrong EnergyPlus build: %s (need %s)" % (version.stdout.strip(), EPLUS_BUILD))
    return exe


def run_energyplus(exe, epjson, out_dir, keep_shading):
    out_dir.mkdir(parents=True, exist_ok=True)
    prefix = epjson.stem
    cmd = [str(exe), "-w", str(WEATHER), "-d", str(out_dir), "-p", prefix, "-s", "C", str(epjson)]
    print("Running EnergyPlus -> %s" % out_dir)
    start = time.time()
    result = subprocess.run(cmd, stdout=subprocess.DEVNULL)
    if result.returncode != 0:
        sys.exit("EnergyPlus failed (exit %d); see %s" % (result.returncode, out_dir / (prefix + ".err")))
    if not keep_shading:
        for f in out_dir.glob(prefix + "Shading.csv"):
            f.unlink()
    print("  finished in %.0f s" % (time.time() - start))
    return out_dir / (prefix + ".eso")


def temperature_stats(ref, new):
    keys = sorted(k for k in ref if k[1].startswith(TEMP_VAR) and k in new)
    rows, total, within, sum_d = [], 0, 0, 0.0
    for k in keys:
        d = [abs(x - y) for x, y in zip(ref[k], new[k])]
        total += len(d)
        within += sum(x <= 0.5 for x in d)
        sum_d += sum(d)
        first = next((i for i, x in enumerate(d) if x > 0.01), None)
        rows.append((sum(d) / len(d), max(d), sum(x > 0.5 for x in d), first, k[0]))
    return sum_d / total, 100.0 * within / total, sorted(rows, reverse=True)


def report(case, ref_eso, new_eso, log):
    ref, new = read_eso(ref_eso), read_eso(new_eso)
    mean_dt, pct_within, rows = temperature_stats(ref, new)
    log("Case: %s" % case)
    log("Reference (ClimateStudio): %s" % ref_eso)
    log("Local run:                 %s" % new_eso)
    log("")
    buf = StringIO()
    with redirect_stdout(buf):
        compare_table(str(ref_eso), str(new_eso))
    log(buf.getvalue().rstrip())
    log("")
    log("%s, by zone (largest differences first):" % TEMP_VAR)
    log("%-28s %8s %7s %9s  %s" % ("zone", "mean|d|", "max|d|", "h >0.5C", "first hour >0.01C"))
    for mean, mx, n, first, zone in rows:
        when = "-" if first is None else "%d (day %d)" % (first, first // 24 + 1)
        log("%-28s %8.4f %7.2f %9d  %s" % (zone[:28], mean, mx, n, when))
    log("")
    passed = mean_dt <= MAX_MEAN_DT and pct_within >= MIN_WITHIN
    log("Mean |difference| in zone air temperature: %.4f C (limit %.2f)" % (mean_dt, MAX_MEAN_DT))
    log("Zone-hours within 0.5 C: %.2f%% (limit %.0f%%)" % (pct_within, MIN_WITHIN))
    log("RESULT: %s" % ("PASS" if passed else "FAIL"))
    return passed


def identical(eso_a, eso_b):
    a, b = read_eso(eso_a), read_eso(eso_b)
    return a.keys() == b.keys() and all(a[k] == b[k] for k in a)


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("case", choices=sorted(CASES))
    p.add_argument("--energyplus", type=Path, default=DEFAULT_EPLUS,
                   help="EnergyPlus folder on an internal drive (default %(default)s, or EPLUS_DIR)")
    p.add_argument("--source", type=Path, default=DRIVE_TOOLS / "EnergyPlus-23.1.0",
                   help="EnergyPlus folder to copy from if --energyplus is missing (default %(default)s)")
    p.add_argument("--repeat", action="store_true", help="run twice and check the runs are identical")
    p.add_argument("--keep-shading", action="store_true", help="keep the ~1 GB shading CSV")
    args = p.parse_args()

    epjson = CASES[args.case]
    ref_eso = epjson.with_name(epjson.stem + "out.eso")
    for f in (epjson, ref_eso, WEATHER):
        if not f.exists():
            sys.exit("Missing input: %s" % f)

    exe = ensure_energyplus(args.energyplus, args.source)
    out = REPO / "runs" / args.case
    new_eso = run_energyplus(exe, epjson, out / "run1", args.keep_shading)

    lines = []
    def log(s):
        print(s)
        lines.append(s)

    passed = report(args.case, ref_eso, new_eso, log)
    if args.repeat:
        eso2 = run_energyplus(exe, epjson, out / "run2", args.keep_shading)
        same = identical(new_eso, eso2)
        log("Repeat run identical to first: %s" % ("yes" if same else "NO"))
    (out / "report.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("Report saved to %s" % (out / "report.txt"))
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
