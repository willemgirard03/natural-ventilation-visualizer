# Natural Ventilation Visualizer

A browser tool that shows architecture students how air moves through their building — in plan, section and 3D, in real time — using the same model they build for ClimateStudio thermal analysis, or one set up without ClimateStudio.

ClimateStudio reports zone temperatures and ventilation rates but shows no airflow pattern. This tool fills that gap: particle flows for whole-building strategies (atria, double-height spaces, stacks, cross ventilation), sash geometry, and the resulting comfort in rooms. EnergyPlus is the reference engine, and the tool's solvers are checked against it.

Not in scope: annual energy simulation, HVAC, or validated quantitative CFD.

## Status

Early development. See [PLAN.md](PLAN.md) for the full plan, requirements, findings and schedule.

## Contents

| Path | What it is |
| --- | --- |
| `prototype/section-airflow.html` | Phase 1 2D section prototype. Open it in any browser. |
| `src/model/` | Project model: `.epJSON` importer and exporter, airflow network export, tool-added interior doors, geometry, constructions, schedules. Plain JavaScript modules, no build step. |
| `src/solver/` | Airflow network solver: zone pressures and flows through every crack, window and door at one moment, matching EnergyPlus's airflow network. |
| `app/import.html` | Model import page: load an `.epJSON`, see it in 3D, see zones, windows, constructions and model checks, export it again. |
| `app/view3d.js` | 3D view of the model (three.js): surfaces by type or zone, windows, shading, a horizontal cut, selection, model-check problems in red. |
| `app/particles.js` | Airflow particles in the 3D view, following the network solver's flows. |
| `tests/` | Automated tests (`npm test`), including checks against EnergyPlus's own reading of the two example models. |
| `tools/run_alignment.py` | EnergyPlus alignment test: re-runs a ClimateStudio model and compares with ClimateStudio's results. |
| `tools/run_energyplus.py` | Runs EnergyPlus 23.1 on any `.epJSON` with the examples' weather file. |
| `tools/check_solver.mjs` | Checks the network solver against an EnergyPlus run, step by step. |
| `tools/compare_eso.py` | Compares two EnergyPlus `.eso` result files output by output; used by the alignment test. |
| `tools/cs_desktop_kit/` | ClimateStudio inspection scripts (see its README). |
| `PLAN.md` | Project plan; read first at the start of every session. |
| `HANDOFF.md` | Notes from the planning chat. |

## Development

Needs [Node.js](https://nodejs.org) 22 or later (development only; the tool itself runs in a browser).

```
npm test        # run the tests; the example-model tests are skipped if E:\ARCH 540\A2 is not present
npm run serve   # serve the repository at http://localhost:8000 and open the import page; offers the two course examples when A2 is present
```

Browsers load JavaScript modules only over http, so open the pages through `npm run serve` rather than by double-clicking them.

## EnergyPlus alignment test

```
python tools/run_alignment.py example02 [--repeat]
```

Runs EnergyPlus 23.1.0 (the build ClimateStudio 2.2 uses) on ClimateStudio's own input file and compares every hourly output with ClimateStudio's results; the report goes to `runs/<case>/report.txt`. Requires Python 3 with no extra packages (Rhino 8's Python works: `%USERPROFILE%\.rhinocode\py39-rh8\python.exe`).

EnergyPlus is kept outside this repository, and it must run from an internal drive: it crashes at startup from an exFAT drive. The script uses `C:\EnergyPlus-23.1.0` (or `--energyplus`, or the `EPLUS_DIR` environment variable) and, if it is missing, copies the ~125 MB needed from `E:\ARCH 540\tools\EnergyPlus-23.1.0` in a few seconds.

To check a file written by the tool, export it and pass it with `--input`; the results must be identical to the original's:

```
node tools/export_epjson.mjs "../Example 02/Results/2226_Emmenweid.epJSON" runs/roundtrip/example02.epJSON
python tools/run_alignment.py example02 --input runs/roundtrip/example02.epJSON
```

To compare any two result files directly: `python tools/compare_eso.py reference.eso candidate.eso`.

## Data

Course models and simulation results are not included: they are not ours to publish, and `.eso` and shading files run to hundreds of megabytes. Scripts refer to them by path on the local drive.

## License

[MIT](LICENSE) © 2026 Willem Girard
