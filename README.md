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
| `tools/compare_eso.py` | Compares two EnergyPlus `.eso` result files output by output; the core of the alignment test. |
| `tools/cs_desktop_kit/` | ClimateStudio inspection scripts (see its README). |
| `PLAN.md` | Project plan; read first at the start of every session. |
| `HANDOFF.md` | Notes from the planning chat. |

## Comparing EnergyPlus results

```
python tools/compare_eso.py reference.eso candidate.eso
```

Requires Python 3, no extra packages. Alignment tests use EnergyPlus 23.1.0 (the build ClimateStudio 2.2 uses), kept outside this repository.

## Data

Course models and simulation results are not included: they are not ours to publish, and `.eso` and shading files run to hundreds of megabytes. Scripts refer to them by path on the local drive.

## License

[MIT](LICENSE) © 2026 Willem Girard
