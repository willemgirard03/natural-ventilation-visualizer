"""Runs EnergyPlus 23.1 on any .epJSON with the Vancouver weather file both examples use.

    python tools/run_energyplus.py <input.epJSON> <output folder>

Uses the same local EnergyPlus copy as run_alignment.py (made on first use; EnergyPlus cannot run
from the exFAT project drive). Results stay in the output folder; put it under runs/, which Git ignores.
"""
import argparse, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_alignment import DEFAULT_EPLUS, DRIVE_TOOLS, ensure_energyplus, run_energyplus


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("input", type=Path)
    p.add_argument("out", type=Path)
    p.add_argument("--energyplus", type=Path, default=DEFAULT_EPLUS)
    p.add_argument("--source", type=Path, default=DRIVE_TOOLS / "EnergyPlus-23.1.0")
    args = p.parse_args()
    exe = ensure_energyplus(args.energyplus, args.source)
    eso = run_energyplus(exe, args.input.resolve(), args.out.resolve(), keep_shading=False)
    err = eso.with_suffix(".err")
    print(err.read_text(errors="replace").strip().splitlines()[-1] if err.exists() else "no .err file")


if __name__ == "__main__":
    main()
