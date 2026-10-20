# Desktop session 1 kit

Three scripts that recover what ClimateStudio doesn't document, on the licensed desktop, in about an hour. All three only read or copy; they don't change models, send anything anywhere, or run anything except what you start yourself.

| File | Runs in | What it answers |
| --- | --- | --- |
| `3_cs_eplus_capture.py` | A terminal window, outside Rhino | The exact EnergyPlus input ClimateStudio writes: ventilation fields, people and CO2 settings, constructions, schedules, network parameters, EnergyPlus version |
| `1_cs_component_dump.py` | A Grasshopper Python component | Every ClimateStudio component's inputs, outputs, types and defaults |
| `2_cs_object_probe.py` | A Grasshopper Python component | What kind of data flows out of a component, e.g. Deconstruct CS Energy Model |

## Before you start

- Copy this folder to the desktop (Git repo, USB stick or cloud drive).
- **Python for the capture script.** Rhino 8 installs one at `%USERPROFILE%\.rhinocode\py39-rh8\python.exe`. If that path doesn't exist, install Python 3 from python.org. No extra packages are needed.
- **A tiny test model:** one box zone (say 5 × 5 × 3 m) on a ground surface, with one window on each of two opposite walls. Make both windows operable with operable fraction 0.5. Keep it small so each run takes seconds.

## Step 1: capture two EnergyPlus runs (most important)

1. Open a Command Prompt in this folder and start the watcher. Adding `--model` also watches the model's folder:

   ```
   "%USERPROFILE%\.rhinocode\py39-rh8\python.exe" 3_cs_eplus_capture.py --model "C:\path\to\test_model.3dm"
   ```

2. Wait for `READY`. The first indexing pass can take a minute.
3. In ClimateStudio, set the airflow mode to **Simple airflow** and run the thermal simulation.
4. When results appear, press **Ctrl+C** in the terminal. A folder `Desktop\cs_capture_<time>` now holds the copied files, `SUMMARY.md`, and a `summary_in.idf.md` (or similar) for each input file found.
5. Rename that folder to `capture_simple`.
6. Repeat steps 1–4 with **Airflow network** mode, and rename the result to `capture_network`.

**Check it worked:** open `SUMMARY.md`. You want at least one input file under "Input files summarized" and an EnergyPlus process under "EnergyPlus-related processes".

**If nothing was captured:**

- Open `processes.jsonl` and search for `energyplus`. The command line shows where ClimateStudio put the files. Rerun with that folder added, e.g. `--roots "C:\that\folder"`.
- If no EnergyPlus process appears at all, ClimateStudio may run EnergyPlus inside Rhino rather than as a separate program. Use Microsoft's free Process Monitor (Sysinternals): filter on Process Name is `Rhino.exe`, Operation is `WriteFile`, Path ends with `.idf` or `.epJSON`. Start the simulation; the path column shows the folder. Rerun the watcher with `--roots` set to it.

## Step 2: list ClimateStudio's components

1. Open Grasshopper with ClimateStudio loaded (any file).
2. Add a Python component: **Python 3 Script** in Rhino 8, or **GhPython** in Rhino 7. Paste in `1_cs_component_dump.py`.
3. Zoom in on the component and add three inputs named `run`, `folder` and `match`, plus one output named `report`. Leave type hints at their defaults.
4. Connect a Boolean Toggle to `run` and set it to True. You can leave `folder` and `match` empty.
5. `report` says where `cs_components.json` and `cs_components.md` were written (default `Desktop\cs_dump`). If it reports that nothing matched, set `match` to `Solemma` and run again.

## Step 3: probe what Deconstruct CS Energy Model outputs

1. Open `CS_Simulation.gh`.
2. Add another Python component and paste in `2_cs_object_probe.py`.
3. Add one input per Deconstruct CS Energy Model output, named anything. Right-click each and set it to **Tree Access**. Wire each Deconstruct output into one input.
4. Add inputs `save` (connect a True toggle) and `folder` (optional), and an output named `report`.
5. The report is saved as `Desktop\cs_dump\cs_probe_<time>.txt`.
6. Optional: repeat on a CS Window output, a CS Energy Zone output and Get CS Space Use Template.

## Step 4: the rest of the checklist

- **Library CSV:** export the ClimateStudio library to CSV. Then create one custom schedule, one material and one construction, export again, and keep both exports.
- **CS Intersector test set:** make two touching boxes, then copies with gaps of 0.1, 0.01 and 0.001 m, one with a half-shared wall, one touching only along an edge, one rotated by 1°, and one with a window crossing the line where the shared wall splits. Run CS Intersector on each, then bake or screenshot its outputs. Running the probe on the outputs also helps.
- **Panel-assigned file:** in a fresh small file, assign zones and windows with the Rhino panel rather than Grasshopper. Set one window's operable fraction to an unusual value such as 0.37 so it can be spotted. Save the file.
- **Solemma templates:** copy the Natural Ventilation and Airflow Network Model Grasshopper templates from ClimateStudio's template folder.
- **Results CSV:** export zone temperatures and ventilation rates from one run.

## What to bring back

Zip and upload these, or commit them to the repo:

- `capture_simple` and `capture_network`. The whole folders are best, but `SUMMARY.md`, the `summary_*.md` files and the input files are the essentials.
- `Desktop\cs_dump`, with the component list and probe reports.
- The two library exports, the Intersector screenshots or baked geometry, the panel-assigned .3dm, the two templates, and the results CSV.

## Tested and untested

The capture script was tested here on a simulated run: a folder appears, gets written to, and is deleted three seconds later. It caught the files, kept their final versions, and summarized both .idf and .epJSON inputs. Its Windows-only parts (instant file events and the process log through PowerShell) and both Grasshopper scripts could not be tested without Windows and Rhino. They are written defensively, but expect to report one or two small fixes.
