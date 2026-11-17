# Methods and sources

How the Natural Ventilation Visualizer works out the air, where each method comes from, and how far each one has been checked. Every method taken from elsewhere is listed here with its source. Methods with no outside source are marked **own**.

The **Checked** column says how the source was used:
- **read**: the paper or source code was read for this tool.
- **cited**: known only through another source, which is named.
- **not read**: cited from general knowledge; still to be checked.

## 1. The chain of models

1. **EnergyPlus 23.1** works out each zone's mean air temperature, CO₂ and surface temperatures, hour by hour. Each zone is one well-mixed air node.
2. **The tool's airflow network** works out the flow through every window, door and crack at a moment. It follows EnergyPlus's AirflowNetwork equations.
3. **The room air solver** (fast fluid dynamics on a grid of cubic cells) works out the pattern of air within and between rooms:
   - The flows through openings come from step 2.
   - Each zone's mean temperature and CO₂ are held to step 1's values.
   - Surfaces exchange heat with the air at step 1's surface temperatures.
4. **The views** (particles, cut planes, probes) read the room air solver. When Flow is set to Ideal flow, they read a potential-flow field instead.

Steps 1 and 2 decide how much air enters and how warm each room is on average. Step 3 decides only how that air moves and spreads within the rooms. So any error in steps 1 and 2 carries straight into step 3.

## 2. Airflow network

| Method | Source | Checked | In the code |
| --- | --- | --- | --- |
| Zone pressures and flows through cracks, simple openings and doors; stack pressure; Newton solve | EnergyPlus 23.1 source: `src/EnergyPlus/AirflowNetwork/src/Solver.cpp` (`calculate_Cps`, `airmov`, `filjac`), `Elements.cpp` (`SurfaceCrack`, `SimpleOpening`, `generic_crack`, `pstack`) | read (20 Oct 2026). Test: the network week matches an EnergyPlus AirflowNetwork run within 0.01% (`tests/solver.test.js`) | `src/solver/network.js` |
| Surface-averaged wind pressure coefficients for low-rise buildings (walls from a correlation, roof from a table, every 30°) | EnergyPlus `calculate_Cps`, which implements Swami and Chandra's correlation | EnergyPlus source read; the original Swami and Chandra paper not read | `src/solver/network.js` |
| Wind speed at the building from the weather station (terrain exponent and boundary layer) | ASHRAE, as EnergyPlus's Building object applies it | EnergyPlus source read | `src/solver/air.js` |
| Moist air density, viscosity, standard pressure | EnergyPlus Psychrometrics, DataEnvironment, AirflowNetwork/Properties | read | `src/solver/air.js` |
| Saturation vapour pressure | ASHRAE Fundamentals (Hyland and Wexler), as EnergyPlus uses it | cited (EnergyPlus) | `src/model/weather.js` |
| Two-way flow bands in an opening (neutral plane; rectangle flow law F ∝ h^3/2) | **own**, from the network's neutral plane | — | `src/solver/paths.js` |
| The AirflowNetwork version of a model for EnergyPlus reruns (discharge coefficient 0.6; open above 25 °C and when warmer than outdoors; cracks for leakage) | ClimateStudio's simple-airflow settings, read from its EnergyPlus input; [ClimateStudio documentation](https://climatestudiodocs.com/docs/thermalZoneSettings.html) | read | `src/model/airflow-network.js` |
| Default window control in reruns: EnergyPlus's own temperature control, fully open above the setpoint and shut below. The minimum venting open factor is 1, because any other value makes EnergyPlus narrow the opening as the indoor-outdoor difference grows | EnergyPlus 23.1 `Solver.cpp`, `venting_control`; field notes in `Energy+.idd` (AirflowNetwork:MultiZone:Zone) | read (13 Nov 2026) | `toAirflowNetwork` |
| Gradual opening (Run ▸ EnergyPlus, off by default): an EMS program at the start of each timestep sets each zone-controlled window's opening factor to its full factor × (T_zone − 25 °C) / 2 K, kept within 0 and 1, and 0 when the zone is no warmer than outdoors or venting is not allowed | Actuator "AirFlow Network Window/Door Opening", "Venting Opening Factor": EnergyPlus `Solver.cpp` (it replaces the venting control's factor). The 2 K band is **own** | read; run on Emmenweid 2226 (section 8) | `gradualVenting`, `GRADUAL_BAND` |
| Tried and not used: EnergyPlus's built-in modulation by indoor-outdoor difference, with the values of its example `AirflowNetwork_MultiZone_SmallOffice.idf` (fully open up to 5 K, 0.3 of open at 10 K) | EnergyPlus 23.1 testfiles, `Solver.cpp` | read and run: it narrowed the openings to 0.3–0.6, but the air still swung 25 → 18 °C | — |
| Results finer than hourly: a week's rerun reports at EnergyPlus's 10-minute timesteps, and the reader averages them to the step asked (10, 20, 30 or 60 min). EnergyPlus is not run with fewer timesteps: its own guidance is "Normal 6 is minimum as lower values may cause inaccuracies". So a longer step does not make the run faster | **own** use of EnergyPlus timestep reporting; guidance from `Energy+.idd` (Timestep) | read; test: `tests/results.test.js` | `zoneResults` (`fine`), `airflow-network.js` (`reporting`, `timestepsPerHour`) |
| Each zone's opening temperature in reruns: the zone's own "Windows open above" (the simple airflow's minimum indoor temperature), else 25 °C; one constant setpoint schedule per temperature. Until 13 Nov 2026 every zone got 25 °C, whatever its setting | **own** (bug fix) | test; run: 2F_Office_8 at 23 °C opened in 6 of 60 ten-minute steps on 15 July and stayed at 16–23 °C | `toAirflowNetwork` (`setpointOf`) |
| Doors (17 Nov 2026): a model's own Door subsurfaces (and those placed with the Door tool) are openings in the network: between rooms open as the Doors setting says, to outdoors shut (a crack) until opened. A door is added between a room and circulation only where the pair has no door of its own. Doors placed in a massing are written as EnergyPlus `FenestrationSurface:Detailed` of type Door, 900 × 2100 mm, 20 mm off the floor, a 40 mm wood leaf (k 0.15 W/m·K) | **own** (sizes and the wood leaf are assumptions; the 20 mm keeps the subsurface inside its wall). EnergyPlus accepts the interzone door pairs (run 17 Nov 2026: no severe errors) | test (`tests/massing.test.js`) | `modelDoors`, `interiorDoors`, `networkElements`; `addDoor`, `massingGeometry` |
| A door's opening (17 Nov 2026): it swings on its hinge up to 90°; its free share of the opening at an angle is the side-hung casement's (the gap along its free edge plus the two end triangles, `freeFraction`), so 36° frees about 87% of a 900 × 2100 mm door and 90° all of it. Drawn swung into its own zone, with its arc in plans | **own**, the same geometry the window sashes use (`src/model/sash.js`); not checked against measurement | — | `doorFraction`, `doorLeaf` |
| Reading and writing .idf (17 Nov 2026): fields in the order of EnergyPlus's IDD, kept in its schema (`Energy+.schema.epJSON`, `legacy_idd`), turned into epJSON as EnergyPlus's ConvertInputFormat does (choices in the schema's spelling, numeric fields as numbers, empty fields left out, unnamed objects keyed "type n", repeating groups as arrays) | EnergyPlus 23.1 `Energy+.schema.epJSON` and `ConvertInputFormat.exe` | checked: two models of about 5,000 objects each (Emmenweid and its airflow-network export, made .idf by ConvertInputFormat) read with no difference from ConvertInputFormat's own epJSON, and written back with none | `src/model/idf.js`, `tools/build-idd.mjs` |
| Airflow paths (17 Nov 2026): a stroke drawn in plan, simplified by Ramer-Douglas-Peucker (tolerance 0.05 m at smoothness 0 to 1.5 m at 1) and drawn as a centripetal Catmull-Rom curve through the points kept; a door (900 × 2100 mm) where it crosses a wall between rooms, a window (1200 × 1500 mm, sill 900 mm) where it crosses an outside wall. It only places openings: it does not predict that air will take that way (a tool to assess that is to come) | standard geometry (Ramer 1972, Douglas and Peucker 1973; Catmull-Rom in its centripetal form, Yuksel, Schaefer and Keyser 2011), written from memory, not read; sizes **own** | test (`tests/massing.test.js`) | `src/model/airpath.js` |

## 3. CO₂

| Method | Source | Checked | In the code |
| --- | --- | --- | --- |
| Zone CO₂ mass balance over the network's flows, stepped implicitly | **own** (standard mass balance) | test: carried between zones without loss | `src/solver/co2.js` |
| People's CO₂: 3.82 × 10⁻⁸ m³/s per W of activity unless the People object says otherwise; outdoor CO₂ from ZoneAirContaminantBalance | EnergyPlus | read when written (code notes); test: the network week's CO₂ follows EnergyPlus within 15 ppm on average | `src/solver/co2.js` |
| EnergyPlus's own zone CO₂ used whenever the results report it for every zone | EnergyPlus results | — | `app/import.js` (`co2FromResults`) |

## 4. Room air solver (fast fluid dynamics)

| Method | Source | Checked | In the code |
| --- | --- | --- | --- |
| Fast fluid dynamics in three steps per time step: semi-Lagrangian advection (first order, trace back one step, trilinear interpolation), then diffusion and sources (implicit), then pressure projection | Jin, M., Zuo, W., Chen, Q. (2012). Improvements of fast fluid dynamics for simulating air flow in buildings. *Numerical Heat Transfer, Part B* 62(6), 419–438. doi:10.1080/10407790.2012.724988 | read (PDF) | `src/solver/grid.js` (`step`) |
| The underlying scheme (stable at long steps) | Stam, J. (1999). Stable fluids. *SIGGRAPH 99*, 121–128 | cited (Jin et al. 2012, ref. 10) | |
| Projection method for incompressible flow | Chorin, A. J. (1967). *Journal of Computational Physics* 2, 12–26 | cited (Jin et al. 2012, ref. 11) | `GridFlow.project` |
| Fast fluid dynamics for airflow in buildings | Zuo, W., Chen, Q. (2009). Real-time or faster-than-real-time simulation of airflow in buildings. *Indoor Air* 19, 33–44 | cited (Jin et al. 2012, ref. 6) | |
| Staggered grid: velocities on cell faces, temperature and CO₂ at cell centres; cells marked fluid or solid | Harlow, F. H., Welch, J. E. (1965). *Physics of Fluids* 8, 2182; marker approach as in Jin et al. 2012 §2.2 | cited (Jin et al. 2012, ref. 15) and read (Jin) | `src/solver/grid.js`, `src/solver/roomflow.js` |
| No viscosity term when turbulence is off: the advection step's numerical viscosity stands in for turbulent viscosity | Jin et al. 2012 §2.1 and §4 (they used no turbulence model either); Zuo, W., Chen, Q. (2010), *HVAC&R Research* 16, 785–798 | read (Jin); cited (Zuo and Chen 2010, Jin ref. 14) | |
| Size of that numerical viscosity: D = h²/(2Δt) · s(1 − s), with s the fractional part of uΔt/h | **own** derivation, measured in a 1D test (13 Nov 2026). At h = 0.75 m and Δt = 1 s, D is 0.017 m²/s for air at 0.05 m/s and 0.068 m²/s at 0.3 m/s: 6–9 times Chen's turbulent viscosity at 1 m from a wall, and about 1,000 times air's own | measured | — |
| The grid laid along the building's walls: the cells' axes turned about the vertical by the walls' prevailing direction. Each horizontal wall run's angle is taken four times over, weighted by its length and averaged as a unit vector, so walls at right angles count as one direction. The solver works in those axes; the model and network are turned into them, and points and velocities are turned back for drawing. No turn below 0.25° | **own** | test: Emmenweid 2226 turns 5.89°, and once turned its walls lie on the axes; air conserved | `src/solver/frame.js` |
| Boussinesq buoyancy, against each connected region's mean temperature | standard; the choice of reference temperature is **own** | test: a heated floor raises a plume and a warm layer | `GridFlow.step` (step 4) |
| Each zone's mean temperature drawn to EnergyPlus's value with a 30 s time constant (`HOLD_TIME`), the pattern within it kept; CO₂ likewise | **own**: makes EnergyPlus the heat balance, and the solver only the pattern within it | — | `GridFlow.step` (step 3), `stepCO2` |
| Surface heat exchange at EnergyPlus's inside surface temperatures, with a fixed coefficient of 3 W/m²K | **own** simplification; the value is a typical natural-convection coefficient (not from a source) | test: a cold wall makes a down-draught | `SURFACE_COEFFICIENT` |
| Heat from people and equipment spread through the occupied height (0.1–1.8 m), lights in the top cells, all convective | **own** assumption (an upper bound on the plumes) | — | `GridFlow.gains` |
| Air over a hopper sash turned up at 45° | **own** approximation, still to check against CFD | test: hopper and awning directions | `GridFlow.step` |
| Long steps (time-lapse): buoyancy's push per step limited to 1 s worth | **own**. Measured on Emmenweid 2226: flow at 2 s steps correlates 0.84 with flow at the solver's own steps (the solver's own flow, a minute apart, correlates 0.97) | measured (PLAN.md) | `buoyDt` |
| Pressure solve: conjugate gradients preconditioned by one V-cycle of aggregation multigrid (2 × 2 × 2 blocks, symmetric Gauss-Seidel) | standard numerical methods; **own** implementation | test: largest cell imbalance below 10⁻⁶ | `src/solver/multigrid.js`, `GridFlow.project` |
| Turbulence (optional, off by default): Chen's zero-equation model, ν_t = 0.03874 · L · \|V\|, with L the least distance to a wall along the three axes; used as the coefficient of an implicit diffusion step (5 Gauss-Seidel sweeps) for velocity, temperature and CO₂; turbulent Prandtl number 0.9 | Chen, Q., Xu, W. (1998). A zero-equation turbulence model for indoor airflow simulation. *Energy and Buildings* 28(2), 137–144. As implemented in the open fast fluid dynamics code of the Modelica Buildings library ([lbl-srg/modelica-buildings](https://github.com/lbl-srg/modelica-buildings), `Buildings/Resources/src/FastFluidDynamics`: `chen_zero_equ_model.c`, `diffusion.c`, `initialization.c`, `solver_gs.c`) | code read (13 Nov 2026); the 1998 paper not read | `diffuse`, `buildTurbulence`, `CHEN_A` |
| Departures from that code | **own**: L measured to any face air cannot cross, not just the domain's outer walls; walls no-slip in the velocity diffusion (Jin et al. 2012 §2.3 describe no-slip walls); Pr_t 0.9 applied to heat and CO₂ (the code defines it). The code computes the speed with the z coordinate where it means the vertical velocity (`*w = var[Z]`), which looks like a slip; here the speed uses all three velocities | — | |
| Settled: the flow's change over 10 s of air has stopped falling (mean over 20 s at least 0.85 of the mean 40 s earlier), or at most 300 s of air | **own**; measured 90–110 s after a weather step, about 190 s from still air | measured (PLAN.md) | `app/grid-worker.js` |

## 5. Ideal flow and particles

| Method | Source | Checked | In the code |
| --- | --- | --- | --- |
| Ideal (potential) flow within each zone, from where the network says air enters to where it leaves | **own** application of potential flow | test: air conserved in every cell | `src/solver/roomflow.js` |
| Particles moved through face velocities, gliding along walls | **own** | test | `src/solver/tracer.js`, `app/particles.js` |

## 6. Playing a day

| Method | Source | Checked |
| --- | --- | --- |
| Weather between the weather file's hours: temperature in a straight line; wind as a vector, so it turns the short way | **own** | — |
| Room conditions at any moment, for the time picked and as the day plays alike: each hour's mean, or each finer step's mean in a rerun, stands at the middle of its hour or step. Temperatures, humidity, CO₂ and surface temperatures are interpolated in a straight line between two middles. Window openings and whether ventilation ran are the hour's or step's own. Beside the time, "interpolated" marks a moment that falls between the data's own times | **own**. Hourly results smooth out changes within an hour (see section 8); a rerun at 10-minute steps shows them | test: `tests/results.test.js` |
| The time picked, to the minute: weather from the file's row on a whole hour, and in a straight line between rows otherwise (the wind as a vector) | **own** (as for the day played) | — |
| Interpolate off: whole hours only, each as recorded: the weather file's row for the hour (the hour ending), and EnergyPlus's mean over it, read at its middle | **own** | — |
| Windows over a weather step longer than the results' steps: open as far as they were on average over the step. A 30-minute step holding one 10-minute step at 0.8 gives 0.27, so the step lets through the same air. With simple-airflow results, the share of the step the zone's ventilation ran | **own** | test: `tests/results.test.js` |
| Following the day, or settling at each weather step when the day plays faster than the air can be worked out | **own** | measured (PLAN.md) |
| Sun position (drawing only): Cooper's declination, Spencer-style equation of time, about 0.1° | as noted in `app/sky.js` | — |

## 7. Validation status

What has been checked:
- **The network** against EnergyPlus's own AirflowNetwork, within 0.01% over a week, and with pivoted sashes within 1%.
- **The room air solver**, for physical behaviour only:
  - plumes rise and warm layers form;
  - cold walls make down-draughts;
  - air is conserved in every cell;
  - long steps stay stable.

What has not been checked yet:
- The room air solver against measurements or against full CFD. The planned comparisons:
  - the room cases Jin et al. (2012) used: Wang and Chen (2009), *HVAC&R Research* 15, 1099–1119. These are an empty room with a jet, a room with a box, and a room with a heated box, all with measured velocity and temperature profiles;
  - a natural-convection cavity (de Vahl Davis, 1983);
  - OpenFOAM on Emmenweid 2226 with the same boundary conditions.
- Sensitivity, which anyone can run in the tool: do the conclusions hold at 0.5, 0.75 and 1 m cells, and with turbulence on and off? A pattern that changes with these settings is not a result.

## 8. Known limits that come from EnergyPlus

- **Well-mixed zones.** Each EnergyPlus zone has one air temperature. In tall spaces the real air stratifies, so the temperature that triggers venting, the stack pressure and the heat to surfaces all differ from one well-mixed node. Jin et al. (2012, introduction) note that the well-mixed assumption of multizone models is not always valid for large spaces, citing Wang and Chen (2008), *Building and Environment* 43, 1671–1677 (cited, not read). The room air solver keeps EnergyPlus's mean, so it inherits this limit.
- **Venting that switches on and off at each timestep.** Emmenweid 2226 vents a zone when its air is above 25 °C and warmer than outdoors (ZoneVentilation:WindandStackOpenArea, minimum indoor temperature 25 °C, ΔT 1 K, no deadband). A rerun of 13–15 July with 10-minute output shows what that does in the 8 m office 2F_Office_8 (81 m² of opening for stack flow):
  1. One 10-minute timestep of venting at about 85 air changes an hour drops the air from 25 °C to about 16–18 °C.
  2. The windows then shut because the air is below 25 °C.
  3. The warm surfaces (mean radiant temperature about 24 °C) bring the air back to 24 °C within about 40 minutes.
  4. It vents again roughly every two hours.

  The hourly results average this into alternating hours of about 21 °C and 25 °C. Windows that open fully for 10 minutes every two hours are an artefact of the control, not how windows behave. How fast the air recovers is plausible: room air holds little heat next to its surfaces.

  The tool's own AirflowNetwork rerun of the same days behaves the same way. In 2F_Office_8 on 15 July, between 05:00 and 17:00:

  | Window control | Opening when it opens | Air temperature range | Hourly means |
  | --- | --- | --- | --- |
  | On/off (default) | 0.80 for one timestep | 16.8–25.1 °C | 21.0–25.0 °C |
  | EnergyPlus's built-in modulation (not used) | 0.29–0.64 | 17.4–25.0 °C | 21.5–25.0 °C |
  | Gradual (EMS, proportional) | 0.01–0.12 | 20.1–25.3 °C | 23.3–24.9 °C |

  Gradual opening removes most of the swing but not all of it. The control acts on the last timestep's temperature, and even a 10% opening of this room's windows cools it in one timestep. A shorter EnergyPlus timestep would narrow the swing further (not tried yet).
