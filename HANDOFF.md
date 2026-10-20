# Handoff: Natural Ventilation Visualizer

Everything built in the planning chat, ready to become the first commit of the repository.

## What's here

| Path | What it is |
| --- | --- |
| `prototype/section-airflow.html` | Phase 1 2D section prototype. Opens in any browser. |
| `tools/compare_eso.py` | Compares two EnergyPlus `.eso` result files output by output. This is the core of the alignment test. |
| `tools/cs_desktop_kit/` | ClimateStudio inspection scripts. The input-file summarizer (`3_cs_eplus_capture.py --summarize`) works without a license. The two Grasshopper scripts need ClimateStudio to compute, so they are kept for later. |

## Before starting Claude Code

1. **Get the plan as `PLAN.md`.** Open the plan document (Natural Ventilation Visualizer — Project Plan) and download it as Markdown. Save it in this folder as `PLAN.md`. The two diagrams become placeholders in Markdown; the text carries everything Claude Code needs.
2. **Copy this folder to the drive.** It ended up at `E:\ARCH 540\A2\natural-ventilation-visualizer` (decided 20 Oct). Apart from this folder, leave `E:\ARCH 540\A2` untouched; it is read-only reference data.
3. **Put EnergyPlus 23.1 on the drive, outside the repository.** Download the portable zip, the exact build ClimateStudio used, and unzip it to `E:\ARCH 540\tools\EnergyPlus-23.1.0`. (Found 20 Oct: it cannot run from the exFAT drive; `tools/run_alignment.py` copies the files a run needs to `C:\EnergyPlus-23.1.0` on each computer. See PLAN.md.)
   https://github.com/NREL/EnergyPlus/releases/download/v23.1.0/EnergyPlus-23.1.0-87ed9199d4-Windows-x86_64.zip

## Key facts Claude Code will need

- **Weather file for both ClimateStudio runs:** `CAN_BC_Vancouver_Intl_AP_718920_TDY-CWEC2020v2.epw`.
- **Primary case, Example_02:** `A2\Example 02\Results\2226_Emmenweid.epJSON` is the run's input; `2226_Emmenweidout.eso` holds its results. The `.idf` beside them is a later edit; do not use it for comparison.
- **Advanced case, Example_01:** `Willem_Girard_CS_V3.epJSON` and `Willem_Girard_CS_V3out.eso`, same rules.
- **Sandbox result to reproduce:** re-running each `.epJSON` with EnergyPlus 23.1 matched ClimateStudio to a mean of 0.009 °C (Example_02) and 0.0003 °C (Example_01). The sandbox had no GPU, so shading was suspected; the desktop run on 20 Oct (GPU) matched solar exactly but temperatures to the same 0.008 °C, so the remaining difference comes from running on a different computer, not shading. See PLAN.md.
- **Never commit** anything from `A2`: no course models, `.eso` files (40–150 MB) or shading CSVs (up to 984 MB). GitHub rejects files over 100 MB, and the repository is public.

## First message to give Claude Code

Open Claude Code in `E:\ARCH 540\natural-ventilation-visualizer` and paste:

> Read PLAN.md and HANDOFF.md first. I'm new to Git and GitHub, so guide me step by step and explain each command before running it. Today's goal is the "First Claude Code task" in PLAN.md's Workflow and constraints section: set up this folder as a Git repository, connect it to a new public GitHub repository under my account willemgirard03 named natural-ventilation-visualizer, add a README, a .gitignore that keeps large simulation files out, and an MIT license (ask me to confirm the license first), then make the first commit and push. After that, the next task is the automated EnergyPlus alignment test on Example_02, using tools/compare_eso.py and the EnergyPlus copy in E:\ARCH 540\tools.

## Keeping context between sessions

Claude Code does not remember earlier sessions. Keep `PLAN.md` current: when a decision is made or a task finished, ask Claude Code to update it and commit. A new session on either computer then starts by reading it.
