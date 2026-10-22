# Natural Ventilation Visualizer — Project Plan

Oct 16, 2026 · @Will

## Purpose and scope

The tool shows students how air actually moves through their building — in plan, section and 3D, in real time — using the same model they already build for ClimateStudio thermal analysis.

It fills the gap ClimateStudio leaves: ClimateStudio reports zone temperatures and ventilation rates, but shows no airflow pattern, no sash geometry, and little about how stack, cross and single-sided ventilation interact.

- **Audience:** architecture students anywhere. A course that teaches ClimateStudio (starting January) prompted the idea and is a likely first audience, but the tool is not designed for one class.
- **Primary job:** show how whole-building strategies (atria, double-height spaces, stacks and shafts, cross ventilation) move air through a building, and how those big moves are felt as comfort in the rooms. Particle flows are shown where the big moves happen; window type, position and opening size refine them. Not code compliance.
- **Not in scope:** annual energy simulation, HVAC, solar gains (for now), validated quantitative CFD. ClimateStudio and OpenFOAM remain the tools for those.
- **Licen****s****e stance:** works with a ClimateStudio model when one exists, and works fully without ClimateStudio.

## Requirements

Every consideration raised so far, in one place. "Phase" refers to the milestones at the end.

| Requirement | Detail | Phase |
| --- | --- | --- |
| Visual, not just numbers | Live particles, speed, temperature and pressure fields; inflow/outflow labels at each opening | 1 (done in 2D) |
| Plan, section and 3D | Section slices and plan slices of one 3D field; 3D particle view | 3 |
| Real-time and lightweight | Interactive on a student laptop; no expensive GPU; 2D prototype runs \~3–5 ms per step (estimated) | 1–3 |
| Captures stack, cross, single-sided ventilation and convection | Buoyancy, wind pressure, two-way flow through one opening, heat plumes | 1 (done in 2D) |
| Transparent method | On-screen explanation of what is computed and what is not | 1 (done) |
| Re-use ClimateStudio model setup | Zones, windows, opening fractions, temperature triggers, occupancy | 2 |
| Work without ClimateStudio | Same conventions set up inside the tool or by layer naming | 2 |
| Windows modelled as planes | Same 3–4 corner planes as ClimateStudio; the tool interprets them as awning, hopper, casement and redraws the sash | 2 |
| Inherited settings with overrides | Values imported from ClimateStudio show their source; an override is marked (asterisk) and can be relinked | 2 |
| Opening schedules | Temperature triggers as in ClimateStudio, plus an optional schedule | 2 |
| Internal gains from occupancy | People density × metabolic rate × occupancy schedule, plus lights and equipment, as ClimateStudio does; no solar gains yet | 2 |
| Stable zone identity | Splitting a zone never renumbers the others; zones keyed to Rhino object IDs or names | 2 |
| Model quality control | Visible checks with click-to-select, like ClimateStudio's red outline for invalid windows | 2 |
| Live sync with Rhino | Changes in Rhino update the tool automatically, with a re-sync button, like Twinmotion's Datasmith link | 4 |
| Students on any laptop | Browser-based core; no install for the basic workflow | 1 |
| CO2 levels | CO2 from occupancy, per zone and as a field in the room; shows whether ventilation is sufficient, not only whether air moves | 2–3 |
| Surface classification like CS Intersector | Split and classify zone surfaces into roof, facade, partition, slab, external floor, ground slab, ground wall | 2 |
| Wall thickness from constructions | Plan and section draw each surface at its construction's total thickness, from ClimateStudio or manual layers | 2 |
| Construction properties | R-value and thermal capacitance per construction, for heat loss through walls and thermal mass | 3+ |
| Simple vs network results | Show ClimateStudio's simple-mode airflow next to the network result, since simple mode assumes an ideal exhaust and cannot show real paths | 3 |
| Pressure coefficient export (opportunity) | Compute wind pressure coefficients that include neighbouring buildings and export them for ClimateStudio's network CP input mode | 4+ |
| EnergyPlus alignment | Data follows EnergyPlus's input format; annual results come from EnergyPlus; fast solvers agree with EnergyPlus; results line up with other EnergyPlus tools | 2–3 |
| Measured occupancy schedules | Schedules from the ASHRAE Global Occupant Behavior Database as an alternative to design templates | 3 |
| Whole-building strategies first | Atria, double-height spaces, stacks and shafts shown with particle flows; their effect shown as room comfort | 2–3 |
| Sash type stored in the tool and in Rhino | Casement by default, awning as the stress test; saved in the tool and written back to Rhino window objects as user text | 2 (write-back later) |

## What the ClimateStudio files contain

The geometry is fully readable without a license; most ClimateStudio settings are too, but some are stored in an undocumented binary format. Checked by reading both files directly (rhino3dm and a decompressed .gh).

**CS\_Building\_Model.3dm**

- 47 zone volumes in this version of the file (the results folder comes from a later version with 46 zones and 92 windows), all closed (valid solids), one per layer named `CS::<Floor>::<Zone>`, e.g. `CS::Third_Floor::Meeting_Med`. The layer path already gives a stable, human-readable zone ID.
- 85 glazing planes on `CS::Glazing`, all single 4-corner faces, all vertical, 84 of them 3.2 m tall. A bounding-box test suggests about 82 exterior and 3 interior windows (approximate; exact assignment needs face matching).
- Ground surfaces, topography, exterior shading and a centre point on their own layers.
- Elevator and stair zones run 24 m tall — natural stack-effect shafts worth showing.
- No ClimateStudio data in object user text: zone and window settings are not stored on the Rhino objects. This is likely because this model is set up through Grasshopper, where the settings live in the .gh file; a model set up in the Rhino panel may store data differently.
- Stray linework: `CS::Third_Floor::Bathroom` holds 9,298 curves (likely imported CAD). An example of what model checks should flag.

**CS\_Simulation.gh** (ClimateStudio 2.2 components)

| Data | Format | Readable without license? |
| --- | --- | --- |
| Component wiring (CS Energy Zone, CS Window, Internal Window, CS Boundary Object, CS Model Maker, Deconstruct CS Energy Model) | Grasshopper archive | Yes |
| Natural ventilation settings | Plain JSON | Yes — buoyancy and wind on, opening setpoint 25 °C, outdoor air 10–26 °C, max humidity 90%, schedule "AllOn" |
| HVAC system | Plain JSON | Yes — heating and cooling off (free-running), mechanical ventilation on |
| Space-use templates and schedules (e.g. "OfficeMedium BLDG\_OCC\_SCH") | Base64 protobuf, field names stripped | Partly — names and hourly values are recoverable, but the layout is undocumented and may change between versions |
| Window operable fraction, people density, metabolic rate | Not in the .gh JSON; confirmed instead in the results folders' .epJSON (see Findings) | Yes, via the .epJSON |

**Deconstruct CS Energy Model** returns ClimateStudio's classified geometry, not settings or results (confirmed by you): Facade, Partition, Ceiling, Roof, External Floor, Floor, FloorGround, WallGround, Adiabatic Wall, Adiabatic Floor, Adiabatic Roof, Window, Internal Window and Shading. Without a license the ClimateStudio components do not compute, so this output is not available; the classified surfaces in the results folders' .epJSON files serve as the reference instead. Zone and window settings have to come from elsewhere: the plain JSON in the .gh, the library CSV export, an EnergyPlus input file if a results folder keeps one, or manual setup.

The fourteen geometry categories map onto the seven construction types. The mapping below is inferred from the names and still to be confirmed:

| Deconstruct output | Construction type |
| --- | --- |
| Facade | Facade |
| Partition | Partition |
| Floor, Ceiling | Slab (the same shared surface, seen from the zone above and the zone below) |
| Roof | Roof |
| External Floor | External Floor |
| FloorGround | Ground Slab |
| WallGround | Ground Wall |
| Adiabatic Wall, Adiabatic Floor, Adiabatic Roof | Unknown; likely the matching wall, slab or roof construction with no heat flow through it |
| Window, Internal Window | Glazing |
| Shading | None |

## Findings from the ClimateStudio results folder

The results folder for a version of the shared model (`Willem_Girard_CS_V3`) contains ClimateStudio's complete EnergyPlus input as `.idf` and `.epJSON`, so these are confirmed facts rather than inferences. Settings may differ from the shared .gh file.

**Run settings**

| Setting | Value |
| --- | --- |
| EnergyPlus version | 23.1 |
| Timesteps | 6 per hour in the `.epJSON` that produced the results (confirmed by EnergyPlus's `.eio`); the later `.idf` has 3, the research report said 4. Corrected 20 Oct. |
| Run period | Full year, hourly outputs |
| Wind | Terrain "Suburbs": profile exponent 0.22, boundary layer 370 m, sensor at 10 m |
| HVAC | Ideal loads with heating and cooling off; mechanical outdoor air capped at zero; so free-running |
| Infiltration | Constant, 0.000168 m³/s per m² of exterior surface (0.03–0.38 air changes per hour depending on the zone) in the `.epJSON`; the later `.idf` and Example\_02 use 0.025 air changes per hour. Corrected 20 Oct. |
| Zones | 46, of which 31 have natural ventilation |
| Windows | 92, all exterior; no interior windows in this run |
| Airflow between zones | None: no airflow network and no zone mixing objects |

**How simple airflow is written.** For each ventilated zone, ClimateStudio writes:

- **One stack object** (name ends `_Buoy`) with the zone's total opening area, the wind term switched off (opening effectiveness 0), discharge coefficient 0.6, and height difference equal to a quarter of the window height (0.8 m for 3.2 m windows).
- **One wind object per facade direction** (`_Wind0`, `_Wind1`, …) with that direction's opening area, effective angle set to the facade's compass direction, effectiveness calculated by EnergyPlus, and the stack term switched off (discharge coefficient 0). Example\_02 instead writes **one wind object per window** (30 for the 30 windows of `2F_Office_8`), each with that window's opening area and compass direction; the importer handles both by working from zone totals.
- **Opening area = glazing area × operable fraction** (0.8 in this model), split by facade direction. The wind areas sum exactly to the stack area.
- **Controls on every object:** minimum indoor temperature 25 °C, indoor at least 1 K warmer than outdoor, outdoor between 10 and 26 °C, maximum wind 40 m/s.
- **An hourly on/off availability schedule** per zone, open 47% of the year here. It appears to pre-apply the outdoor temperature and humidity limits hour by hour.

What this means for students:

- **Each zone is ventilated on its own.** No air passes between zones, so a stair or elevator shaft cannot drive stack ventilation across floors, and air cannot cross the building from one zone to another. The tool's network solver shows exactly what this leaves out.
- **Wind and stack are added, not combined.** EnergyPlus combines wind and stack flow inside one ventilation object; splitting them into separate objects likely adds them instead, which tends to overstate airflow when both act. To confirm against EnergyPlus's documentation.

**CO2 is calculated; reporting it is optional.** CO2 tracking is on, with outdoor CO2 from a yearly schedule of 409–415 ppm and EnergyPlus's default generation rate of 3.82×10⁻⁸ m³/s per watt of activity. At 125.28 W per person that is 0.0048 L/s, close to Persily and de Jonge's 0.0043 L/s. No CO2 output was requested in this run, so its results do not include it; the later version requests it, so ClimateStudio can report CO2. The tool can match these inputs exactly and show CO2 even when a ClimateStudio run did not ask for it.

**People.** 0.0565 people/m², 125.28 W per person in every zone (one template). That is 1.2 met × 58 W/m² × 1.8 m², so ClimateStudio uses 58 W/m² per met, not the 58.2 in its documentation. EnergyPlus calculates the sensible share itself (sensible heat fraction set to autocalculate), so the tool should use EnergyPlus's correlation. Fraction radiant 0.3; occupancy schedule "OfficeMedium BLDG\_OCC\_SCH" (peak 0.95).

**Constructions.** R and heat capacity computed from the layers, without surface film resistances.

| Surface type | Construction | Thickness | R (m²·K/W) | Heat capacity (kJ/m²·K) |
| --- | --- | --- | --- | --- |
| Facade | 2226 Exterior Wall (plaster, two 365 mm clay block layers) | 0.795 m | 7.39 | 609 |
| Roof | NECB-2020 CZ 8 Exterior Roof (Mass) | 0.509 m | 8.95 | 479 |
| Partition | 200mmConcrete | 0.200 m | 0.10 | 456 |
| Slab (ceiling side; floor side flipped) | 300mm concrete, 80mm insulation, 80mm screed | 0.460 m | 2.56 | 848 |
| Ground slab | 300mmInsulation 200mmConcrete | 0.500 m | 8.92 | 471 |
| External floor | defaultConstruction (no construction assigned) | 0.250 m | 0.11 | 504 |
| Windows | TriplePaneLoE, simple glazing | — | U 0.785 W/m²·K | SHGC 0.764, VT 0.661 |

Interzone surfaces appear twice, once per zone, with a `_FLIPPED` copy of the construction that reverses the layer order. The external floors silently fell back to a default construction, an example of what model checks should flag.

**Usable results.** The hourly `.eso` file holds zone air, operative and radiant temperatures, ventilation and infiltration heat flows and humidity, readable without ClimateStudio (e.g. one zone ranged 16.3–30.8 °C over the year). This is the comparison data for validation. The binary `.csr` file is not needed.

**Second pass: what the first reading missed**

- **Two model versions.** The `.epJSON` (26 January) is the input that produced these results: the outputs finished two minutes after it was written and report the same 46 people objects. The `.idf` is a later version (29 January). It removes people, lights and equipment from storage, stairwells and elevators; adds more shading context (1,336 surfaces vs 420); requests the `Zone Air CO2 Concentration` output; and switches to the custom `CDS_*` constructions from Assemblies.gh, which also fixes the default external floor.
- **Lights and equipment.** 6.57 W/m² of lighting and 10.33 W/m² of equipment in every zone, each on its own OfficeMedium schedule. Together that is about four times the sensible heat from people, so the tool's gains must include them.
- **Ground temperature.** A constant 18 °C every month, EnergyPlus's typical value for ground under a heated building, not Vancouver's actual ground temperature. It matters for ground-floor zones.
- **Weather and site.** Vancouver International Airport weather (a Canadian weather year file); the shading surfaces include surrounding context reaching about 700 m south of the building. Shading affects solar gains only; it plays no part in simple-mode wind.
- **Space template.** "90.1-2019 MediumOffice - OpenOffice" (ASHRAE 90.1-2019), with outdoor air rates of 2.36 L/s per person plus 0.30 L/s per m², unused here because mechanical outdoor air is capped.
- **Convection.** Inside surfaces use the TARP algorithm, outside surfaces DOE-2.
- **The `.csr` file is partly readable.** It is ClimateStudio's own container: version string, weather file path, simulation settings (ground temperatures, reflectance), the space template, construction names, fuel types with what look like carbon and cost factors, then the hourly results as binary numbers. Not needed while the EnergyPlus files exist.
- **Unventilated zones.** The 15 zones without natural ventilation are bathrooms, storage, stairwells, elevators, medium meeting rooms and one vestibule.

**Custom constructions in the later version** (computed from layers, without film resistances):

| Surface type | Construction | Thickness | R (m²·K/W) | Heat capacity (kJ/m²·K) |
| --- | --- | --- | --- | --- |
| Facade | CDS\_EW1: brick, wood fibre board, plywood, cellulose, brick | 0.720 m | 8.16 | 665 |
| Partition | CDS\_W1: two gypsum boards each side of 180 mm cellulose | 0.230 m | 4.60 | 54 |
| Slab | CDS\_F1: concrete topping, fibreboard, 175 mm CLT | 0.226 m | 1.51 | 237 |
| Roof | CDS\_R1: tile, ballast, plywood, 300 mm wood fibre, 175 mm CLT | 0.590 m | 8.91 | 399 |
| Ground slab | CDS\_EF1: 300 mm wood fibre board, concrete | 0.402 m | 7.19 | 333 |
| External floor | CDS\_EF2: siding, wood fibre board, CLT, fibreboard, concrete | 0.538 m | 8.79 | 347 |

ClimateStudio's three natural ventilation modes are described under ClimateStudio methods to replicate. Source for the simplified model ([Thermal Zone Settings](https://climatestudiodocs.com/docs/thermalZoneSettings.html)).

## ClimateStudio methods to replicate

Three parts of the ClimateStudio pipeline need to be reproduced so the tool works without a license and reads the same model the same way: surface classification, constructions, and the library.

**Surface classification (CS Intersector).** Every zone solid passes through CS Intersector, which splits faces where zones meet and decides what each piece is. ClimateStudio assigns a construction to each of seven surface types ([Thermal Zone Settings](https://climatestudiodocs.com/docs/thermalZoneSettings.html)):

| Surface type | ClimateStudio definition | How the tool can detect it |
| --- | --- | --- |
| Roof | Exterior top surfaces | Upward-facing face with no zone above it |
| Facade | Exterior side surfaces | Vertical face with no zone on the other side, above ground |
| Partition | Interior walls | Vertical face shared with another zone |
| Slab | Interior floors (also used for interior ceilings) | Horizontal face shared with a zone above or below |
| External floor | Exterior bottom surfaces not touching the ground | Downward face with no zone below and not on a ground surface |
| Ground slab | Exterior bottom surfaces touching the ground surface | Downward face coincident with a ground surface |
| Ground wall | Exterior surfaces below the ground surface that are not a ground slab | Face, or part of a face, below the ground surface |

The detection rules are my proposal, not CS Intersector's documented logic. Partial overlaps matter: a wall half shared with a neighbour must split into a partition piece and a facade piece, and a window can only sit on the facade piece. Matching ClimateStudio's split results on the sample building is the test.

**Constructions.** Each construction is a stack of material layers ordered outside to inside, each with a thickness in metres. Opaque materials are defined by properties including thermal conductivity and specific heat ([Manage Library](https://climatestudiodocs.com/docs/manageLibrary.html)). From the layers the tool can compute three values:

```latex
R_{layers} = \sum_i \frac{t_i}{k_i} \qquad C = \sum_i \rho_i \, c_i \, t_i \qquad T = \sum_i t_i
```

where t is thickness (m), k conductivity (W/m·K), ρ density (kg/m³) and c specific heat (J/kg·K). R is in m²·K/W, C in J/m²·K, T in m. Whether ClimateStudio's reported R-value also includes surface film resistances is unconfirmed.

- **Thickness in drawings:** plan and section draw each surface as a band of thickness T, so the student sees walls, not lines. Which side of the modelled surface the thickness goes (inside, outside or centred) is an open question.
- **Thermal use:** R gives heat loss through walls; C gives thermal mass (how slowly a heavy wall warms). Both are later phases; the 2D prototype treats walls as perfectly insulating with no mass.

**The Assemblies.gh template** shows the manual route, in four components:

1. **Get CS Material** searches the library by name (the example searches "Brick").
2. **Construct CS Layer** takes a material and a thickness in metres.
3. **Construct CS Construction** takes a name ("MyConstruction"), a category ("Facade"), the layers ordered outside to inside, and optional embodied energy, embodied carbon, cost and life.
4. Outputs are the **Construction** and a **Construction Information** summary.

The tool's manual setup should mirror these inputs so a student who has built constructions in ClimateStudio recognises them.

**The library.** Zone templates, schedules, materials and constructions all live in the ClimateStudio library, locked by default. The whole library can be exported or imported as a set of CSV files ([Manage Library](https://climatestudiodocs.com/docs/manageLibrary.html)). A CSV export would give the tool every material, construction and schedule the class uses, but it needs a license; for now the same data comes from the EnergyPlus input files in the results folders.

**Natural ventilation in ClimateStudio.** ClimateStudio is an EnergyPlus front end with no airflow solver of its own. Ventilation is calculated one of three ways, chosen in the advanced simulation settings. AirflowNetwork options and their override of the simple zone controls are confirmed on [Thermal Zone Settings](https://climatestudiodocs.com/docs/thermalZoneSettings.html); the three mode names come from the research report.

| ClimateStudio mode | What EnergyPlus computes | What it cannot show | What the tool does |
| --- | --- | --- | --- |
| Simple airflow (default) | Each zone exchanges air with outdoors through `ZoneVentilation:WindandStackOpenArea`; the wind term assumes an "ideal exhaust" | Which window air enters or leaves by; any flow between zones | Network solver finds the actual paths; show both results side by side so students see why they differ |
| Airflow network | Pressure network of zone nodes linked by openings, including flow between zones; wind pressure coefficients from EnergyPlus's surface-averaged formula based on building shape | Effect of neighbouring buildings on wind pressure | Same kind of network; the main comparison target for validation |
| Airflow network CP input | Same network with pressure coefficients supplied from outside, e.g. CFD | — | Opportunity: the tool could compute context-aware coefficients and hand them to ClimateStudio |

**Other ClimateStudio behaviour to match** (from the research report unless linked):

- **Window placement:** windows must be planar, 3–4 corners, fully inside one parent surface and not touching its edges (an EnergyPlus constraint). Model checks should flag edge contact, and a window crossing a split line between two zones' surfaces must be split or flagged.
- **Infiltration:** constant design flow per zone (coefficients 1, 0, 0, 0), with the rate taken from each zone's template ([Thermal Zone Settings](https://climatestudiodocs.com/docs/thermalZoneSettings.html)).
- **Simulation defaults:** 6 timesteps per hour in both runs we have (the report said 4), hourly results, full year.
- **Wind:** weather-file wind is corrected for terrain and sensor height; the tool should apply the same correction so wind speeds line up.
- **Results:** saved as binary `.CSR` files beside the Rhino file; tables can be exported to CSV from the interface, which is the practical route for comparisons.

**Update:** the simple-mode fields are now known (see Findings from the ClimateStudio results folder). Still open: which opening type and closed-window leakage it writes for the network, and whether every interior window becomes a network opening. A results folder from an airflow network run would answer these.

**Compatibility target.** The tool matches ClimateStudio's inputs and their meaning, not its numbers to the decimal. Numerical agreement needs the exact EnergyPlus input ClimateStudio writes, which is not public.

## EnergyPlus foundation

EnergyPlus is the reference engine: the tool's data follows EnergyPlus's own input format, its annual results come from EnergyPlus, and its fast solvers must agree with EnergyPlus for the same inputs. ClimateStudio becomes one input source among several, and results line up with any other EnergyPlus-based tool.

| Layer | Role | Speed |
| --- | --- | --- |
| EnergyPlus annual run | Reference results for the whole year: zone temperatures, ventilation (simple or airflow network), CO2, comfort | Minutes; runs outside the browser |
| Network solver | The same airflow network equations as EnergyPlus, for one moment in time | Milliseconds |
| Grid solver | The airflow pattern inside rooms, with flows at openings taken from the network | Real time |

- **Data model = EnergyPlus objects.** Zones, surfaces, windows, constructions, materials, schedules, people, lights, equipment, infiltration, ventilation, airflow network and CO2 objects are stored as EnergyPlus defines them. Fields EnergyPlus has no place for (sash type, hinge side, overrides) live in a side table keyed by object name.
- **Import from any EnergyPlus tool.** ClimateStudio, Honeybee (Ladybug Tools), OpenStudio and DesignBuilder all write `.idf` or `.epJSON`; ClimateStudio's results folder is one case of this.
- **Export and run.** The tool writes `.epJSON` and runs EnergyPlus on it, in two variants: ClimateStudio-style simple airflow (to reproduce ClimateStudio) and airflow network (to show flow between zones).
- **Alignment test.** Re-running the imported ClimateStudio model through the tool's own export must reproduce ClimateStudio's hourly zone temperatures. Then the network solver is checked against EnergyPlus's airflow network for the same hours.
- **Where EnergyPlus runs.** As far as I know there is no supported browser build, so a small local runner (a Python script using an installed EnergyPlus or its Python API) or a server is needed. Pin version 23.1 to match ClimateStudio; EnergyPlus releases twice a year. Open decision.

**Gate test, step 1: passed.** EnergyPlus 23.1 (the same build ClimateStudio uses, 23.1.0-87ed9199d4) was installed in a Linux sandbox and run on ClimateStudio's own input files, unmodified, with the matching weather file. Every hourly output was compared with ClimateStudio's results:

| Model | Zones | Run time | Mean difference in zone air temperature | Zone-hours within 0.5 °C | Annual totals |
| --- | --- | --- | --- | --- | --- |
| Example\_01 (Willem\_Girard\_CS\_V3) | 46 | 136 s | 0.0003 °C | 99.99% | within 0.01% |
| Example\_02 (2226\_Emmenweid) | 12 | 96 s | 0.009 °C | 99.7% | within 0.03% |

- **Weather file:** the runs used `CAN_BC_Vancouver_Intl_AP_718920_TDY-CWEC2020v2.epw`, identified from the extreme design week (10–16 August) and three sizing temperatures. The CWEC2020v2, TMYx and three morphed future files do not match.
- **Shading explains the sandbox's Example\_01 difference but not Example\_02's** (corrected 20 Oct; both were first put down to shading). ClimateStudio asks for GPU pixel counting; the sandbox had no GPU and fell back to polygon clipping, so transmitted solar differed by about 0.01% over the year. On the desktop's GPU (below), transmitted solar matches exactly in both models: Example\_01's difference disappears, but Example\_02's is unchanged. Lights, equipment and people match exactly in all runs.
- **The larger hourly differences come from window control flipping.** In naturally ventilated zones on warm afternoons, both runs swing 2–4 °C from hour to hour: windows open above 25 °C, the large opening area dumps the heat within one 10-minute step, the windows close, and the cycle repeats. Tiny numerical differences shift the timing of each flip. This on/off behaviour of ClimateStudio's simple ventilation is itself worth showing students.
- **Where EnergyPlus runs:** a Linux server works and runs these models in 1.5–2.5 minutes; a GPU is needed only to reproduce pixel-counting shading exactly.

**Gate test, step 1 repeated on the desktop (20 Oct): passed for both models.** `tools/run_alignment.py` ran EnergyPlus 23.1.0-87ed9199d4 on Windows with GPU pixel-counting shading, on ClimateStudio's unmodified `.epJSON` files:

| Measure | Example\_02, desktop (GPU) | Example\_02, sandbox | Example\_01, desktop (GPU) | Example\_01, sandbox |
| --- | --- | --- | --- | --- |
| Run time | 2 min | 96 s | 2 min 39 s | 136 s |
| Outputs compared | 285 | — | 1,074 | — |
| Mean difference in zone air temperature | 0.0084 °C | 0.009 °C | 0.00000005 °C | 0.0003 °C |
| Largest hourly difference | 5.8 °C | — | 0.000002 °C | — |
| Zone-hours within 0.5 °C | 99.74% | 99.7% | 100% | 99.99% |
| Transmitted solar | identical | about 0.01% off | identical | about 0.01% off |
| Annual totals | within 0.05% for most outputs; ventilation heat gain 7.9% (a small total) | within 0.03% | identical to 4 decimal places | within 0.01% |
| Warnings and severe errors | 36 and 2, as in ClimateStudio's run | — | 99 and 11, as in ClimateStudio's run | — |

- **Example\_01 is reproduced exactly**, to the precision of the `.eso` files. With GPU shading, nothing distinguishes the desktop's run from ClimateStudio's.
- **Example\_02 is identical until late July.** Every zone matches ClimateStudio to within 0.01 °C for the first 210 days. Differences begin on day 211 (30 July) and stay in the three naturally ventilated offices (`GF_Office_2_1`, `GF_Office_1_0`, `2F_Office_8`; up to 5.8 °C in single hours), with small spill-over into the two meeting rooms. Circulation, toilets and the stairwell never differ by more than 0.05 °C.
- **Why the two models differ.** EnergyPlus is repeatable on one computer: three Example\_02 runs on the desktop were bit-identical. Between computers it is not quite: Example\_01's residual differences of about 0.000002 °C show rounding-level differences between the desktop and ClimateStudio's computer. In Example\_01 they stay at that size. In Example\_02 they are amplified once a window opening lands on the other side of its 25 °C setpoint, after which the window control flipping described above follows a different sequence. This is an interpretation consistent with all runs, not a proof; finding the first hour a window state differs would confirm it. Exact agreement on Example\_02 is not achievable without ClimateStudio's own computer, so the test thresholds are a mean difference of at most 0.05 °C and at least 99% of zone-hours within 0.5 °C.
- **Example\_02's sensitivity is a property of the model.** Small changes in window timing produce hour-to-hour differences of several degrees in its naturally ventilated offices. The tool should show this on/off sensitivity rather than hide it.
- **EnergyPlus cannot run from the project drive.** The drive is formatted exFAT, and EnergyPlus 23.1 crashes at startup (Windows error 0xC0000409 in `ucrtbase.dll`) when started from it; the same files run normally from C:, with or without spaces in the path. See Workflow and constraints for how each computer gets its copy.

**Repeated on the laptop (20 Oct): the same result.** On the laptop (GTX 1660 Ti Max-Q), Example\_02 gave the desktop's figures to every digit reported: mean difference 0.0084 °C, 99.74% of zone-hours within 0.5 °C, the same largest differences per zone, and the first divergence on the same day (211). Two laptop runs were identical; each took about 2 min 40 s. So the desktop and the laptop agree with each other, and ClimateStudio's computer is the odd one out.

Step 2: the same comparison for an input file written by the tool itself rather than by ClimateStudio. **First part passed (20 Oct):** Example\_02 imported into the project model and exported by `tools/export_epjson.mjs` gives EnergyPlus results bit-identical to the original file's (`run_alignment.py example02 --input runs/roundtrip/example02.epJSON`). This proves the import–export path loses nothing. Still to do: the same test once export writes objects from the model's own values (overrides, the airflow-network variant), where any difference would come from the tool.

**Airflow network reference (20 Oct).** `src/model/airflow-network.js` writes the network variant of an imported model, and `node tools/export_epjson.mjs <in> <out> --network` saves it. Settings:

- **Windows:** ClimateStudio's values, as simple openings (discharge coefficient 0.6, open over the operable fraction).
- **Window control:** open above 25 °C when warmer than outdoors, within ClimateStudio's hourly availability schedule.
- **Wind pressure:** EnergyPlus's surface-averaged coefficients, with the long axis and width ratio measured from the footprint.
- **Leakage:** cracks in every exterior and interzone surface at 1 m³/h per m² at 50 Pa, and along closed windows at 0.5 m³/h per m, replacing the constant infiltration. These figures are the tool's choice, not ClimateStudio's.
- **Doors:** the interior doors the tool adds (Data model), always open.

**What a crack is.** No gap is drawn anywhere. A crack is one lumped leakage element per surface: flow = C × (pressure difference)^0.65, with C sized by the surface's area. EnergyPlus evaluates it at a single point, the surface's centroid height, so a whole wall leaks like one small hole at its middle and can only flow one way at a time. Real leakage concentrates at joints (window frames, floor and roof edges, corners, penetrations), and a tall wall can leak in at the bottom and out at the top. With windows open, cracks carry 1–2% of the flow; with windows closed they are all of it. The particle view therefore spreads crack flow over the whole surface as faint seepage rather than a jet. Distributing leakage along joints, or splitting tall walls into height bands, would be more realistic. It would also no longer match EnergyPlus, so it belongs as an option.

Results on Example\_02 (EnergyPlus 23.1, full year, no severe errors in the annual run):

| Variant | Mean flow through windows | Between zones | Zone temperature vs ClimateStudio's simple mode |
| --- | --- | --- | --- |
| Network, cracks only | 13,745 m³/h | 122 m³/h through cracks, under 1% | mean difference 0.31 °C, 92% of zone-hours within 0.5 °C |
| Network with the 17 added doors | 14,001 m³/h | 9,482 m³/h through the doors (318–712 m³/h each, median 602); 20 m³/h through cracks | mean difference 0.62 °C, 42% within 0.5 °C; circulation zones differ most |

- **Without interior openings the network is twelve separate rooms.** That is why the doors were added.
- **With doors, the stairwell works as a stack.** Over the year, about 210 m³/h enters it through its ground-floor doors and leaves through its upper-floor doors; in July and August about 340 m³/h. This is the kind of path the network solver must reproduce.
- **Sizing warmup does not converge with doors.** EnergyPlus reports 6 severe errors, all in the extreme-summer sizing period for the ideal-loads equipment, which is switched off; the annual run converges. Worth removing later, for example by skipping zone sizing in the network variant.
- **Corrected 20 Oct:** the first door run wrote the doors' corners from the wrong starting corner for this model's geometry rules, so EnergyPlus read each door as 2.1 m wide and 0.9 m tall. The figures above are from the corrected run.

**Network solver (built 20 Oct).** `src/solver/network.js` solves the same network for one moment: zone pressures and the flow both ways through every crack, window and door. It follows EnergyPlus 23.1's AirflowNetwork source code equation by equation, and the export and the solver share one list of network elements. Checked against an EnergyPlus run of Example\_02 for 1–7 July at 10-minute steps (`node tools/check_solver.mjs`, also an automated test): 1,008 steps, 138 links, every step converged.

| Links | Mean flow | Difference from EnergyPlus |
| --- | --- | --- |
| Windows | 19,687 m³/h | 0.000% |
| Doors | 10,461 m³/h | 0.001% |
| Cracks | 288 m³/h | 0.001% |

Each solve takes about 0.3 ms on the laptop, against 25 s for EnergyPlus to simulate the week. Fast enough to re-solve every frame while a student drags a window or changes the hour. What matching EnergyPlus exactly required, each worth knowing when comparing with ClimateStudio:

- **ClimateStudio's weather station is suburban.** Its files contain a `Site:WeatherStation` that places the wind sensor in suburban terrain (exponent 0.22, 370 m) rather than EnergyPlus's default open country. Wind speeds at the building come out 40% higher, and wind pressures 95% higher, than EnergyPlus's defaults would give. The same applies to ClimateStudio's simple mode.
- **EnergyPlus solves the network with the previous timestep's zone temperatures**, before updating the zones.
- **A surface's height in the network is EnergyPlus's centroid**: the plain average of the corners when a surface has five or more. For Example\_02's L-shaped roof planes that is 1.2 m above the true centre of area.
- **Particle view (first version, 20 Oct).** `app/particles.js` animates particles along the solver's flows in the 3D view. `src/solver/paths.js` turns a solution into streams: one per direction per link, and in two-way openings the colder side's air uses the bottom band, split at the neutral plane. Particles enter wherever outdoor air comes in, cross each zone towards its outflows (chosen in proportion to their flow), and leave or pass on, coloured by air temperature. They show the network's paths, not the pattern inside rooms, and the controls say so. Controls: outdoor and indoor temperature (one indoor value for every zone for now), wind speed and direction, windows open or closed, animation speed. A readout gives outdoor air in m³/h and air changes per hour, and selecting a window, door, surface or zone shows the air through it. With all of Example\_02's windows open, 18 °C outside, 26 °C inside and a 3 m/s west wind: 160,700 m³/h, 24 air changes per hour. With windows closed, 118 m³/h of leakage. Particles are released steadily in proportion to the flow, at a rate fixed once per model so more flow shows more particles, and the view starts with air already spread along its routes (the first version released them in pulses).
- **Room flow (21 Oct): particles keep to the rooms.** The first particle view flew straight between openings and could cross walls. Now `src/solver/roomflow.js` divides the building into 0.5 m cells (each zone's volume within 1.3% for Example\_02) and solves ideal (potential) flow in each zone. Air enters and leaves at the cell faces each window, door and crack covers, in exactly the network's amounts, and cannot cross walls. Particles move through that field, slide along walls, pass to the next zone only through openings air leaves by, and leave windows as short jets. Each draws a streak showing where it will be in the next 6 s, so direction and speed are visible. Ideal flow has no buoyancy, turbulence or recirculation, so a room with closed windows shows nearly still air, and a single-sided window makes a short loop from the bottom of the opening to the top. The grid solver (Physics roadmap 3) replaces it with real room-scale flow, reusing the same cells and opening faces. Tested: air is conserved in every cell. Timing for Example\_02 (53,000 cells): cells 20 ms, opening faces 0.2 s, once per model; each new hour 0.3 s, done after the controls settle.
- **Trails and colours (21 Oct).** Each particle's trail runs through its last eight positions over 6 s, so it curves with the path it took, round corners and along walls; about 4,000 trailing particles run at the display's frame rate (96 per second on the laptop). Particles can be coloured by air temperature or by speed (log scale, 0.01 to 2 m/s). Surfaces can be coloured by the pressure difference across them in the hour solved, from the network: blue where air is pushed into the room, red where it is pushed out, on a square-root scale so a few pascals across a facade still show beside tens across a roof. A pressure field inside rooms waits for the grid solver; ideal flow has none worth showing. On particles meeting walls: leakage is already part of the field, so particles pass through a wall's leak into the next zone, or out, in proportion to its flow, and otherwise slide along it.
- **Open doors between rooms at one temperature (21 Oct).** EnergyPlus computes an open simple opening's one-way flow with its closed leakage coefficient when the air on both sides has nearly the same density (within 0.0001 kg/m³, about 0.03 K). In its own runs that is rare, but with one indoor temperature for every zone every door behaved as closed: about 19 m³/h each at 1.7 Pa, where an open 0.9 × 2.1 m door passes about 6,600 m³/h. The tool now treats it as the open orifice it is (Cd A √(2ρΔp)); `solveNetwork(…, { exactEnergyPlus: true })` keeps EnergyPlus's behaviour for the comparison, which still matches to 0.001%.
- **Rerun in EnergyPlus (21 Oct).** When windows or doors differ from a results file, the notice offers a rerun. The dev server runs EnergyPlus on the tool's airflow network model for the week ending on the day picked, with the windows and doors as set (held open or closed for the week; windows left to the setting "As in results" keep the 25 °C control), and lays the week's results over the loaded ones. "As in results" then follows each window's opening from EnergyPlus, so the airflow matches EnergyPlus exactly. Why a week, not the hour: about 20 s of every run is fixed overhead, and a short run loses the building's thermal history. Runs ending 15 July 15:00, against the full year:

  | Run | Time | Zone temperatures at 15:00 against the full year |
  | --- | --- | --- |
  | 1 day | 23 s | mean 1.2 °C off, up to 2.4 °C |
  | 3 days | 27 s | mean 0.9 °C, up to 3.1 °C |
  | 1 week | 29 s; 18 s without sizing | mean 0.25 °C, up to 1.7 °C |
  | Full year | 235 s | — |

  Sizing runs are skipped when the ideal-loads equipment is switched off (ClimateStudio's free-running models): identical results, 11 s saved. Warm-up does not converge in summer weeks (7 severe errors) because the network's window control flips around 25 °C; the week that follows still agrees with the full year as above. Example: with every window held open for 9–15 July, the zones at 15 July 15:00 sit 0.1–0.6 °C above the 18.6 °C outdoors instead of ClimateStudio's 21–25 °C, so the stack effect nearly vanishes; the airflow barely changes at that hour only because a 7.8 m/s wind dominates it.
- **Doors open or closed (21 Oct).** The added doors can be closed all together (Doors setting) or one by one. A closed interior door leaks like a gap of about 1 cm under it: 30 m³/h per m of its edge at 50 Pa, about 180 m³/h for a 0.9 × 2.1 m door (the tool's figure). Found on the way: when the air on both sides of an open simple opening has almost the same density, EnergyPlus computes its flow with the closed opening's leakage coefficient, so that coefficient matters even for open doors; the July week reference was re-run and the solver matches again (0.001%). The annual door figures above were computed with the earlier, smaller coefficient. A notice appears when windows differ from a results file, since the results' temperatures, and with them the stack effect, assume the results' own windows.
- **Windows one by one, and a vertical section (21 Oct).** Opening or closing windows needs no EnergyPlus run: the network re-solves at once and the room flow follows in about 0.3 s. Besides the Windows setting (all open, all closed, as in results), a selected window can be opened or closed, and a selected room (or any of its surfaces) can have all its windows opened or closed; Reset windows undoes these. Open windows show in their own colour. With a results file, zone temperatures stay as recorded for the hour: opening windows would change them over the following hours, which only a thermal simulation shows. Example: 15 July 15:00, opening the windows of `GF_Office_2_1` as well raises the building's outdoor air from 347,000 to 443,000 m³/h. A vertical section cuts along or across the footprint's long side at any position, keeping the half away from the camera (Flip for the other), together with the horizontal cut.
- **Particles glide instead of sticking (21 Oct).** Particles stuck at walls because their velocity was averaged from cell centres, which near a wall still points slightly into it; each step pushed them in and the slide that followed left almost no motion. `src/solver/tracer.js` now reads each velocity component from the cell faces it crosses, as fluid solvers do on a staggered grid: a wall face carries no flow, so particles keep only their motion along a wall and glide. Leaving particles are carried out at the opening's speed and fade within 1.5 s, instead of hovering at the window. Trails and leaving particles fade by transparency. Tested: parcels never enter a wall, and none stands still where the air moves. With a single window open in a room, ideal flow loops near the window and the far corners are nearly still (about 0.002 m/s); that is the flow model, not a fault, and the grid solver's buoyancy will stir them. The readout names the rooms with windows open, since "As in results" often leaves the ground floor closed (15 July 15:00: only the double-height office).
- **Results file (21 Oct).** A results file (`.eso`, such as ClimateStudio's) gives each zone its own temperature and humidity for the hour picked, and windows can open as in the results: open where the zone's natural ventilation ran that hour. The file streams in (ClimateStudio's run to 150 MB); opening an example on the dev server also reads its results. Example: 15 July 14:00–15:00 has only the double-height office ventilating, and it then carries 349,000 m³/h. The ground-floor offices, closed, get about 1,000 m³/h through doors and leaks.
- **Wind rose (21 Oct).** On the ground around the building: how often the wind blows from each of 16 directions in the month picked, shaded by speed, with this hour's wind as an arrow and north marked, to check the particles against. A Particles slider sets their density.
- **Hour from the weather file (20 Oct).** `src/model/weather.js` reads an `.epw`; a day and an hour slider fill in outdoor temperature and wind, which stay editable, and the hour's humidity and pressure go to the solver. The site's elevation and latitude come from the weather file. The dev server offers the course weather files and picks the one ClimateStudio's runs used. Checked against EnergyPlus for 1–7 July: temperature, wind speed and direction, pressure and humidity ratio all match for all 168 hours. EnergyPlus takes outdoor humidity from the file's relative humidity, not its dew point (0.4% apart). Example: 15 July 14:00–15:00 is 18.6 °C with a 7.8 m/s east-south-east wind; with every window fully open and 26 °C inside, Example\_02 then gets 74 air changes per hour. "Windows open" means all operable windows at once, which a window control would rarely allow. Next: zone temperatures, and window states, from a results file.
- **Simple openings treat the pressure difference at their centre as if it were at their bottom.** This places the neutral plane half the opening's height higher than physics would. The tool reproduces it for the comparison. A later option could offer the physical version, and the difference is worth showing students.


These runs are the reference for the tool's network solver: hourly flow through every opening and crack (`AFN Linkage` outputs) and node pressures.

**Case study choice.** Example\_02 is the lighter validation case: 12 zones, the same ClimateStudio conventions, and it requested CO2 output, so its results include hourly CO2 for every zone to check the tool's CO2 calculation against.

## Architecture

The tool is a browser app with one project model at its centre; ClimateStudio and Rhino are inputs, not dependencies.

&#91;embedded content: tool architecture · 3 inputs, 1 project model, 2 solvers, 1 viewer\]

Dashed boxes are optional inputs. The importer works the same whether data comes from ClimateStudio or manual setup, so students without a license lose nothing but the import step. The ClimateStudio route reads the .epJSON that every ClimateStudio thermal run leaves in its results folder: it already contains the classified surfaces, windows with opening areas, constructions, schedules, people and ventilation settings, and reading it needs no license.

**Delivery form.** Start as a web app that reads a saved .3dm (runs on any laptop, no install). Add live sync later through a small Rhino plugin that watches for edits and sends changed objects by ID to the tool, either in a panel docked inside Rhino or a browser tab on the same machine. A re-sync button re-sends everything if the link breaks.

## Data model

Every setting carries its source, so the tool can show where a value came from and let students override it without losing the link.

**Objects**

| Object | Geometry | Key | Settings |
| --- | --- | --- | --- |
| Zone | Closed solid, as in ClimateStudio | Rhino object ID, plus layer path as a readable name | Name, people density, metabolic rate, occupancy schedule, other internal loads |
| Exterior window | 3–4 corner plane on a zone face | Rhino object ID | Operable fraction, opening setpoint, outdoor temperature limits, schedule, **sash type**, **hinge side** |
| Interior window | Plane on a shared face between two zones | Rhino object ID | Same as exterior; door-like openings could be modelled as full-height interior windows (my assumption, unconfirmed) |
| Ground, adiabatic, shading | Surfaces, as in ClimateStudio | Rhino object ID | Boundary type only |
| Site | — | — | Weather file, wind speed and direction, outdoor temperature |

**Surfaces and constructions**

| Object | Source | Settings |
| --- | --- | --- |
| Classified surface | Split from zone solids, as CS Intersector does | Surface type (one of seven), the zones on each side, its construction |
| Construction | ClimateStudio library CSV, a Grasshopper construction, or manual setup | Name, category, layers outside to inside; computed R-value, capacitance, total thickness |
| Material | ClimateStudio library CSV or manual | Conductivity, density, specific heat |

Each zone holds one construction per surface type, as in ClimateStudio; a surface takes its construction from its zone and type, and can be overridden like any other value.

**Interior doors added by the tool (decided 20 Oct).** ClimateStudio models often have no interior openings (Example\_02 has none), which leaves the airflow network with no paths between zones. The tool adds one open door, 0.9 × 2.1 m, between each room and each circulation zone it shares a wall with, and between adjoining circulation zones. It sits on their largest shared wall, centred at the floor. Circulation is recognised by zone name (circulation, corridor, hall, lobby, stair, vestibule, foyer, atrium); elevator shafts get none. Example\_02 gets 17 doors, Example\_01 63. They show in the 3D view as added by the tool, and are written only into the network variant. Students will later move, resize, close or delete them, and draw their own.

Sash type and hinge side are the new fields: ClimateStudio has no equivalent, so they default to casement, the closest match to how ClimateStudio treats windows. Awning is the stress test: when open it leaves gaps at the sides, so its free-area calculation differs. Sash type is set and saved in the tool and also written back to the Rhino window objects as user text (lower priority).

**Window interpretation.** The plane is the rough opening. The tool chooses the sash angle that gives the inherited operable fraction as free area, then draws that sash in plan, section and 3D. For example, an awning at 0.3 operable fraction opens to the angle whose gap equals 30% of the plane's area. Where a mechanism cannot reach the fraction (a hopper limited to about 35°), the tool says so.

**Window types (built 21 Oct).** `src/model/sash.js` interprets each window plane as the rough opening of a hinged sash: casement (hinged at one side, opening out, up to 90°; the default), awning (hinged at the top, opening out, up to 45°) or hopper (hinged at the bottom, opening in, up to 35°). The limits are typical restrictor settings, the tool's assumption. Free area is geometric: the smaller of the rough opening and the gaps around the open sash, which are a gap along the free edge (edge length × the chord it moves through) plus a triangle at each side. The tool finds the angle that frees the window's operable fraction and draws the sash swung to it in 3D; when the limit cannot reach that fraction, the window's details say so and the airflow uses what the sash frees, as do reruns. For Example\_02's 1.3 × 2.4 m windows, 80% free needs 30° as a casement but only 16° as an awning or hopper: on a tall sash the side triangles carry most of the opening, which makes the awning the stress test. Sash type is set for all windows or one by one (and a casement's hinge side), for this session only; saving it with the model, and writing it back to Rhino, come later. The network still treats every window as EnergyPlus's simple opening (full height, width scaled by the fraction), so the sash changes how far a window opens, not yet where along its height the air passes; the grid solver will take the sash's actual gaps.

**Opening amount per window (21 Oct).** Each window has an opening amount, 0–100% of its sash's travel (100% = the mechanism's limit), set with a slider in its details. The free area at that angle is the opening factor EnergyPlus gets, in the airflow and in reruns. By default a window opens to the amount that frees the model's operable fraction: 32% of a casement's 90° travel (29°) frees ClimateStudio's 80% on Example\_02's windows. An amount the user sets is an override of an inherited value (to be marked as such when overrides are saved with the model).

**Walls drawn with thickness (21 Oct).** In the 3D view, windows and doors are cut out of their walls, and surfaces can be drawn as solids of their construction's total thickness, with a location line: the modelled surface at the interior finish (the solid grows outwards), centreline, or exterior finish (the solid grows into the room). Surfaces shared by two zones are drawn once, centred, since the model has them as two coinciding surfaces. Drawing only: EnergyPlus and the airflow use the zones as modelled. Open doors leave their opening clear.

**Mitred corners and window depth (21 Oct).** The envelope's solids are built together: each corner of a surface's inner and outer faces is placed where the faces of every envelope surface meeting there meet, each at its own thickness, so corners wrap with the interior finish as location line, merge with the exterior finish, and walls close against roofs of other thicknesses. Surfaces shared by two zones stay centred and run into the envelope. In thick walls, windows can sit at the exterior face, centre or interior face (drawing only).

**Opening size and speed (21 Oct).** A partly open window or door now passes its air through that share of its width in the room flow, centred, as EnergyPlus narrows a simple opening, so its jet keeps its speed and narrows instead of slowing over the whole opening: one window of Example\_02 at 25% open passes 6,400 m³/h through 4 cell faces at up to 1.8 m/s, fully open 24,900 m³/h through 12 faces at up to 2.3 m/s.

**What the particles do not show yet (21 Oct).** Their temperature is an illustration: they start at their source's temperature and take on their room's over about a minute, whatever their speed; a temperature field carried and mixed by the air comes with the grid solver. Nor is there entrainment (fast air past a door drawing air out of the room): the network has one pressure per zone and no momentum between openings, and ideal flow has none by definition. The grid solver carries momentum, so it shows some, within its cell size.

**Sashes in the room air (22 Oct).** A hinged sash's gap grows from nothing at its hinge to its widest at its free edge, so in the room air (simulated and ideal) an open window's air is spread along it in proportion to that local gap: under an awning (low), over a hopper (high), away from a casement's hinge. A hopper's sash is inside the room, so air coming in over it is turned upwards, taken as 45° (as fast upwards as inwards); an approximation to check against OpenFOAM. Awnings and casements open outwards, outside the grid, so their deflection of the air before it enters is not modelled. Original note: **Air redirected by the sash (later).** Air having to pass under an awning or over a hopper needs the sash as an obstacle in the room flow: the grid solver, where the sash is solid cells, as in the 2D prototype. EnergyPlus's detailed opening (AirflowNetwork:MultiZone:Component:DetailedOpening, with opening factors along the height for horizontally pivoted windows) could carry part of it into the network while staying comparable with EnergyPlus; worth testing then.

**Inherited vs overridden.** Each value has one of three states:

| State | Shown as | Meaning |
| --- | --- | --- |
| Inherited | Plain value, ClimateStudio icon | Read from the ClimateStudio export; updates on re-import |
| Overridden | Value with asterisk | Changed in the tool; survives re-import; "Relink" restores the inherited value |
| Local | Plain value, tool icon | Set in the tool with no ClimateStudio source (manual setup, sash type) |

Overrides are stored by object ID, so they follow the object through re-imports and geometry edits.

**Importer (built 20 Oct).** `src/model/import-epjson.js` reads any `.epJSON` into the project model; `app/import.html` shows it. Plain JavaScript modules with no build step, so it runs in any browser.

- **Lossless.** Every EnergyPlus object is kept exactly as read; the model's views (zones, classified surfaces, windows, constructions, ventilation, gains, schedules) sit on top. Export currently writes the objects back unchanged; overrides will be applied to that copy.
- **Sources.** Every setting read from the file is an inherited value that names its EnergyPlus object and field; values the tool computes or sets itself (computed volume, sash type) are local. Operable fraction is derived as opening area ÷ glazing area and says so.
- **Surface types** come from EnergyPlus's surface type and outside boundary condition, mapped to ClimateStudio's seven types plus adiabatic variants. This is not yet CS Intersector's geometric splitting, which a model built without ClimateStudio will need.
- **Model checks** so far: zones that do not close (naming the reversed surface), floors facing up and roofs facing down, interzone pairs that do not face opposite ways, missing partners, constructions, materials and schedules, default constructions, windows off their wall's plane, volume mismatches, natural ventilation without windows.
- **Tested** (`npm test`, 14 tests) against EnergyPlus's own reading of both examples (its `.eio` report): every zone's extents, volume, floor area, window area, infiltration flow, people, lighting and equipment density agree. Example\_02 imports with no problems. Example\_01 has two geometry defects, which EnergyPlus also warns about: floor `3F_Workspace_2_25:f8` faces up, and wall `GF_Circ_5:f9` faces into its zone and is 1.79 m longer than the zone. Constructions match the table above exactly.
- **3D view (built 20 Oct).** `app/view3d.js` (three.js, loaded from a CDN, no build step) draws the model on the import page from the stored corner points: surfaces coloured by surface type or by zone, lighter on the side they face and darker inside; windows; shading. Controls: a horizontal cut, a shading toggle, and Fit. Left click selects a surface or window and shows its details and checks; right drag orbits, middle drag pans. The view is centred on the zones, not the shading, and shifted to the origin so far-off models (Example\_01 near x = 1,550 m) stay precise. Surfaces named by a model check are red, with an arrow showing the way EnergyPlus takes as outward. Each check's "Show in 3D" cuts a plan 1.5 m above the item and frames its zone; this shows Example\_01's reversed wall `GF_Circ_5:f9` facing into its zone and floor `3F_Workspace_2_25:f8` facing up. The dev server offers both examples as buttons when they are on the computer.
- **The tool's page, in the Solar Shading Explorer's look (22 Oct).** `app/import.html` is the tool itself, not a demo: the engine (`src/`) and this page are what students use. It now follows Will's A1 v9 shading tool: its palette, IBM Plex type and components (`app/styles.css`). A sticky calculation settings bar holds the model, weather and results files, the date and time, the outdoor conditions, windows, doors, sashes and room air, with the airflow figure under it; it folds to one line. The 3D view has its own bar: colour by, Layers (particles, air on the cuts, flow arrows, shading, wind rose), Walls (location line, windows' depth), Add section, Add plan cut, perspective or parallel, fit and full screen; its legend is at its foot and the model's tables fold away under it. Walls are drawn at their thickness with the interior finish as location line by default. A view cube (`app/viewcube.js`) turns the camera to any of 6 faces, 12 edges and 8 corners, with a ring marking true north.
- **Section planes (22 Oct).** `app/sections.js`: sections and plan cuts are objects, dragged in from the view's bar (or a click on the button, then on a room: a section goes through the middle of that room, a plan cut 1.5 m above its floor), up to eight. Each removes one side within its bounds, as a cropped section in Revit, through a patch on every material (walls, windows, particles and slices are cut alike). Picked, a plane shows the shading tool's gumball (x, y and z arrows, snapping to 50 mm, a click on one types a move in mm; an arc turns it, 1 degree steps, 15 with Shift) and a grip on each side of its bounds; its outline drags it along its normal; Flip and Delete in its details. `app/caps.js` draws what each plane cuts as on a drawing: wall, floor and roof solids filled with the shading tool's poche (45 degrees, 5 px apart, 1 px lines in --ink3) and outlined in --ink. `app/slices.js` gives each plane arrows for the air's movement in it, as in the 2D prototype (every 0.8 m, full length at 1 m/s), over its temperature or speed if chosen; where it does, particles behind it are hidden while walls still show through. The old horizontal cut slider and along/across section are gone.
- **Typed figures, placing and speed (22 Oct, second round).** A click (without dragging) on a gumball arrow or a plane's outline types a move in mm, on the arc an angle, on a grip that side's size; turning snaps to the world's axes within 10 degrees. A new plane follows the pointer and stands square to the wall under it, so pointing at a building's short side gives a long section; on a floor or roof a plan cut goes 1.5 m above the room's floor. Figures beside sliders (date, time, particle density and speed, a window's opening) can be typed over. The view's bar stays under the settings bar until the view scrolls past. A change of conditions took about 300 ms and now takes 30-45 ms (both examples): the page's copy of the grid solver, which only reads the worker's steps, no longer builds the pressure solve; the view draws at most once a frame; the wind rose is built once a month. Later the same day: the planes show particles trailing in them, as in the 2D sandbox, instead of arrows (2.5 per m² of air, trails fading out, as fast as the 3D particles); a typed box appears only for the gumball's controls; outlines are cut by the other planes too (they were not, so a plan cut's outline floated where a section had cut it away); outdoor and indoor temperature, wind speed and direction are figures whose names drag them and whose values type (as at the foot of the shading tool's views), and Date and Time's names drag their sliders; the wind arrow has a handle in the view, dragged round the building for the direction and in or out for the speed (0 to 20 m/s). **Web or desktop:** staying web. A desktop wrapper (Electron) would run the same JavaScript and WebGL, so no faster; the slowness was in the code, and the heavy work already runs off the page in a worker. A desktop build would help only to bundle EnergyPlus for reruns, which the dev server does now.
- **Not read yet:** zone lists and spaces, `Schedule:Compact` and `Schedule:File`, window U-values for layered glazing (only the simple glazing system's), airflow network objects.

## Thermal gains

Internal gains follow ClimateStudio's people model: peak density × metabolic heat × the hour's occupancy fraction. Lights and equipment add heat the same way (density × schedule) and must be included: in the sample run they give about four times the heat from people. Solar gains are out of scope for now.

ClimateStudio defines 1 met as 58.2 W/m² of body surface and assumes 1.8 m² per adult, so a seated adult gives off about 104 W. Occupancy schedules hold 8,760 hourly fractions between 0 and 1 ([Thermal Zone Settings](https://climatestudiodocs.com/docs/thermalZoneSettings.html), [Schedule Editor](https://climatestudiodocs.com/docs/scheduleEditor.html)).

```latex
q_{people}(t) = \rho_{people} \cdot M \cdot 58.2 \cdot 1.8 \cdot s_{occ}(t) \quad [\mathrm{W/m^2\ floor}]
```

where ρ is people per m² of floor, M is the metabolic rate in met, and s is the occupancy schedule value at hour t.

- **Where the heat goes:** people are spread over the occupied zone of the floor (0.1–1.8 m above it), not just the floor surface. This produces body-height plumes rather than a heated floor.
- **Time control:** students pick a date and hour, or scrub through a day; the gain, the outdoor conditions and window states update together.
- **Equipment and lighting:** included from the start, with the same pattern (density × schedule) and ClimateStudio's values from the results folders.
- **Sensible heat:** ClimateStudio passes the total metabolic heat and lets EnergyPlus calculate the sensible share (sensible heat fraction set to autocalculate), so the tool uses EnergyPlus's correlation.

**CO2.** The same occupancy that drives heat gains also produces CO2, and CO2 is the clearest measure of whether a room is ventilated enough. Each zone tracks a CO2 balance:

```latex
V \frac{dC}{dt} = N(t)\,G + Q\,(C_{out} - C) \qquad C_{steady} = C_{out} + \frac{N\,G}{Q}
```

where V is zone volume, C the indoor concentration, N the number of people (density × floor area × schedule), G the CO2 generated per person, Q the outdoor airflow into the zone from the solvers, and C\_out the outdoor concentration.

- **Example:** 20 people at about 0.005 L/s each with 100 L/s of outdoor air gives about 1,000 ppm above outdoor. Halve the airflow and it doubles.
- **Generation rates:** G from Persily and de Jonge (2017), by age, sex and metabolic rate; for example about 0.0043 L/s for an adult aged 21–30 at 1.2 met, averaged across sexes. The table covers seven metabolic levels (1.0–4.0 met), so values between them are interpolated. Outdoor CO2 defaults to 400 ppm (Carbonfly's default) and should be editable.
- **In the room:** the grid solver carries CO2 like temperature, so stale corners and short-circuiting between two windows show up as a field, not just a zone average.
- **CO2 field in the grid (built 22 Oct).** `src/solver/grid.js` carries CO2 with the air as it carries temperature: people's CO2 goes into the occupied layer (0.1 to 1.8 m), outdoor air brings outdoor CO2 in at inflows, mechanical outdoor air dilutes the whole room, and each zone's mean is held near the network balance's figure (30 s), so the field adds where in a room the air is stale or fresh. The page sends each zone's figure, generation and supply to the worker once the CO2 history is done; "Air on the cuts: CO2" shows it (with ideal flow, each room's own figure). Found on the way: a window on the edge of the grid's box had no cell beyond it to hold the outdoor air, so inflows there never brought outdoor temperature (or CO2) in; the incoming volume now replaces that much of the cell's air each step. Test: a room with an open south window and ten people's CO2 is fresher by the window than at the back, its mean held within 40 ppm of its figure.
- **Status:** ClimateStudio always calculates CO2 and reports it when asked (Example\_02 does; see Findings from the ClimateStudio results folder). The tool should offer ClimateStudio's inputs as one option (3.82×10⁻⁸ m³/s per watt, outdoor schedule around 413 ppm) next to Persily and de Jonge, and always show which it used.

**CO2 per zone (built 22 Oct).** `src/solver/co2.js` keeps the balance above over the airflow network: people × activity × 3.82×10⁻⁸ m³/s per W (the model's own People inputs), outdoor CO2 from `ZoneAirContaminantBalance`, air between zones carried both ways, stepped implicitly and split into parts when a window changes a room's air many times in one step. The page steps it hour by hour through the 48 hours before the hour picked, from outdoor levels, with each hour's weather, the results' room temperatures and the windows and doors as set now (a week gives the same figure within 2 ppm). Zone info shows it beside the results' own `Zone Air CO2 Concentration` where they have it, and the view can be coloured by it (green at 400 ppm, amber at 1,000, red from 1,500). Persily and de Jonge's rates and the field in the grid solver are still to come. Two findings on the way, both of which EnergyPlus applies silently:
- **Free-running models still get mechanical fresh air.** ClimateStudio switches the ideal-loads units' heating and cooling off, but the units stay on and supply each zone's `DesignSpecification:OutdoorAir` minimum: (people now × per-person rate + floor area × per-area rate) × the outdoor-air schedule, at standard density. In Example\_02 that is 0.121 kg/s (about 0.4 air changes an hour) in the ground-floor office when full, and around the clock in circulation, toilets and the stairwell (`AllOn`). It is the main fresh air in winter, when the windows stay shut. The tool's figures match EnergyPlus's `Zone Ideal Loads Outdoor Air Mass Flow Rate` exactly; it enters the CO2 balance but not yet the airflow network or the particles, since EnergyPlus treats it as supply air outside the network.
- **Daylight saving time shifts every schedule.** With `RunPeriodControl:DaylightSavingTime` (Example\_02: 2nd Sunday in March to 1st Sunday in November, whole days, 12 March–5 November in its year), EnergyPlus reads schedules an hour ahead while the weather file and results stay in standard time. The tool's schedules now do the same, which moved occupancy, gains and CO2 one hour earlier in summer; the hour label adds the clock time on those days.

Check against EnergyPlus (`tools/check_co2.mjs`, in the tests): the July week of the network run, each 10-minute step's flows from the solver, hourly means against EnergyPlus's. Mean difference 13 ppm over all 12 zones (EnergyPlus means about 500 ppm, peaks 630–920), largest 145 ppm in single hours just after a window flushes a room, where EnergyPlus shortens its own time step. Before the two findings above, 145 ppm. Against ClimateStudio's year results, which use its simple ventilation rather than the network, the upstairs office agrees within about 30 ppm on 15 July and reads 70–140 ppm lower on 15 January (the two airflow models' winter leakage differs; not yet traced).

**Reused from Carbonfly** (open source, LGPL-3.0). Carbonfly's CO2 transport is OpenFOAM's own multi-species solver, so it cannot be lifted into a real-time tool. Its published inputs can be reused, implemented from the original sources:

- **CO2 generation table** (Persily and de Jonge 2017), above.
- **Breathing defaults:** 12 breaths per minute, 7.2 L/min. Exhaled air is therefore about 3.6% CO2. The tool's grid is too coarse for a breathing jet, so people become a steady CO2 and heat source at head height.
- **Air quality bands:** EN 16798-1 categories by indoor-minus-outdoor CO2 (I: up to 550 ppm, II: 800, III: 1,350, IV: above), plus six other national standards. Carbonfly's caution carries over: CO2 indicates ventilation rate, not overall air quality.
- **Single-sided window check:** Maas (1995) empirical formula for flow through one open window from wind speed, sash height and temperature difference; a quick cross-check for single-sided cases.
- **Default wind pressure coefficients:** EN 1991-1-4 external pressure coefficients by facade zone for rectangular buildings, as a fallback for the network solver when no context-aware values exist. These are structural wind-load values, so treat them as rough.

**Measured occupant behaviour (ASHRAE Global Occupant Behavior Database).** The database holds field measurements, not design templates: occupancy, occupant counts, window, door, shading, lighting, fan, plug load and HVAC behaviour from studies worldwide. Two Canadian studies were checked:

| Study | Building | Data | Period |
| --- | --- | --- | --- |
| 8, Toronto | Apartments | Window open/closed (12 windows in 8 rooms), indoor temperature and humidity (30 rooms), on-site weather | April–August 2012, 15-minute |
| 9, Ottawa | University offices (26 rooms) | Occupancy and lighting on/off events | May 2018 – July 2020 |

- **Occupancy differs sharply from templates.** Ottawa offices peak at about 47% occupied on weekdays, against 95% in the OfficeMedium template; the daily mean is 0.25 vs 0.38. That changes heat gains and CO2 by roughly half at midday. Caveats: overnight values near 11% are probably sensor-gap artefacts, and data after March 2020 include pandemic conditions.
- **Window behaviour is noisy.** Toronto windows were open 68% of the time with little dependence on outdoor temperature, from a small, gappy sample (37,000 of 113,000 records valid). Useful as an illustration, too thin to build a window-opening model from.
- **Use in the tool:** measured profiles as a schedule source next to ClimateStudio templates and manual schedules, so students can compare design assumptions with how buildings are actually used.
- **API:** a REST service at `api.ashraeobdatabase.com` (list behaviour types, search studies by behaviour, country, city and building type, download as ZIP) wrapped by the MIT-licensed `obplatform` Python package. Not testable from here; the data's own terms of use need checking before the tool redistributes any of it.

## Physics roadmap

The 2D prototype proves the solver; the path to 3D adds a fast network layer so a whole building stays real-time.

1. **2D section solver (done).** Grid solver with buoyancy, heat gains, wind boundary layer and sash geometry as solid cells. Mass balance within 0–9% across test cases; closed windows read zero flow.
2. **Network layer (solver built 20 Oct; see EnergyPlus foundation).** One node per zone, one link per opening, solving wind and stack pressures in milliseconds. Gives flow rates for every opening in every zone (12 in Example\_02, 46 in Example\_01), checked against EnergyPlus's own airflow network run of the same model.
3. **3D grid (first version 21 Oct, whole building).** `src/solver/grid.js`, fast fluid dynamics on the room cells (0.5 m): semi-Lagrangian transport of velocity and temperature, Boussinesq buoyancy, heat from people, equipment and lights (all taken as convective, people and equipment through the occupied height, lights at the ceiling), and a pressure correction, on a staggered grid. Windows and leaks to outdoors carry the network's flows; open doors are openings in the grid, so flow between rooms, two-way exchange included, comes out of the solution; leaks between zones are left out. Each zone's mean temperature is drawn to its known value (30 s), so the solver adds the pattern within rooms rather than its own heat balance. It runs in a worker; particles take their colour from its temperature field. Checks: in a closed room, 500 W on a 1 m² patch of floor raises a 0.6 m/s plume and a warm layer (26 °C under the ceiling, 21 °C at the floor, mean held at 22 °C), with every cell balanced; on Example\_02 the stairwell draws air in at the ground floor and out at the upper floor. Speed: Example\_02 (53,000 cells) about 140 ms a step, roughly real time, with the pressure solve at 1e-3 (same flow as 1e-5 within 0.5%, a third of the time). Next for it: multigrid for the pressure solve, sashes as obstacles, surface temperatures from EnergyPlus, plan and section slices of the fields, a finer grid for a focus area, and the validation against OpenFOAM below. Original plan: **3D grid for a focus area.** The student picks a few zones (or one floor); the 3D grid solves those in detail, using network flow rates as boundary conditions at the openings. Plan and section are slices of this field.
4. **GPU port.** Move the solver to WebGPU so finer grids and more zones stay interactive. Measure on a typical student laptop before committing.
5. **Validation.** Compare against EnergyPlus for every model, and 3–5 room-scale cases against Carbonfly/OpenFOAM (same geometry, same boundary conditions). Publish the comparison in the tool so students know how far to trust it.

**Surface temperatures in the grid solver (built 22 Oct).** Reruns ask EnergyPlus for every surface's inside temperature, hourly; the results reader keeps them and merges them like the rest. Every surface and window is mapped to the cell faces it covers, and in the simulation each exchanges heat with the air beside it at 3 W/m²·K (natural convection, the tool's figure). Tested: a north wall at 12 °C in a room at 22 °C cools the air beside it, which sinks down the wall. ClimateStudio's results have no surface temperatures, so surfaces stay neutral until a rerun; the room air readout says which. Example: after a rerun of 9–15 July with every window closed, 166 surfaces of Example\_02 drive the room air, and the rooms are at 25–33 °C at 15:00. Original proposal: **Buoyancy inside rooms from surface temperatures (proposed 21 Oct).** The 3D grid solver (step 3) brings buoyancy inside rooms, from heat gains. Warm and cool surfaces drive room air too: a sunlit floor, a cold window, heavy walls releasing the day's heat at night. Rather than computing wall conduction and thermal mass in the tool, the grid solver can take each surface's inside temperature from EnergyPlus (`Surface Inside Face Temperature`, hourly), which already includes thermal mass, solar and conduction, as a wall boundary condition. ClimateStudio's results do not report surface temperatures, so they would come from the tool's own EnergyPlus runs (the rerun). This replaces the later "wall conduction from R-values and thermal mass from capacitance" item for anything EnergyPlus has run.

Added with the constructions and CO2 requirements: the network layer carries a CO2 balance per zone (phase 3); the grid solver carries CO2 as a second field next to temperature (phase 2 for 2D, phase 3 for 3D); wall conduction from R-values and thermal mass from capacitance follow once the airflow side is validated.

Aligning with ClimateStudio's engine: the network solver should follow EnergyPlus's airflow network formulation (zone nodes, opening links, mass balance), so its results can be compared directly with a ClimateStudio network run. Wind at each opening should use the same terrain and sensor-height correction EnergyPlus applies, replacing the prototype's fixed 0.22 profile.

**Priority: whole-building strategies.** The main use is big moves such as atria, double-height spaces and stair or elevator shafts, with their effect felt as comfort in the rooms. So the 3D grid covers the big moves and the rooms that open onto them at coarse resolution (roughly 0.25–0.5 m), particle flows are shown there, and other rooms are handled by the network. Sash-level detail appears only where a student zooms in. Whole-building 3D at sash resolution is not a goal: at 10 cm cells a 46-zone building is tens of millions of cells.

**Test cases for big moves:**

- **Example\_02:** `2F_Office_8` is an 8 m double-height space with 102 m² of windows; `GF_Stairwell_6` rises 12 m with no windows.
- **Example\_01:** four 24 m stair and elevator shafts with no windows.
- **An atrium variant of Example\_02** (for example, opening the stairwell to the office and adding a roof vent) can be validated against EnergyPlus through the tool's own export, though not against ClimateStudio.

## Workflow and constraints

No ClimateStudio license is available, so validation works only from the two runs already provided, and the project moves between computers on a removable drive with GitHub as the shared copy.

| Constraint | Consequence |
| --- | --- |
| No ClimateStudio license | Validate only against Example\_01 and Example\_02 and their files. ClimateStudio's Grasshopper components can be inspected but their settings cannot be changed or re-run. The licensed capture experiments planned earlier (component dump, network-mode run, Intersector test set) are dropped unless a license becomes available. |
| Project on a removable drive | Everything lives under `E:\ARCH 540`. Files shared in this chat are in `E:\ARCH 540\A2`; treat that folder as read-only reference data, except the repository folder `A2\natural-ventilation-visualizer` and two session files beside it: `A2\SWITCH_MACHINE.md` (read before moving the drive; records the handoff state) and `A2\SESSION_CHECK.md` (read when starting on a computer; checks and fixes the setup, records each machine's status). Both stay local and are rewritten at every switch and check. |
| Several computers | The code repository sits on the drive and is pushed to GitHub, so any computer can continue. |
| Context does not travel | This plan is exported to `PLAN.md` in the repository; Claude Code reads it at the start of each session. Decisions made later are added to it. |
| EnergyPlus is the reference engine | EnergyPlus 23.1 (free) must be available on whichever computer runs the alignment tests, on its internal drive (it crashes when run from the exFAT project drive). With a GPU, pixel-counting shading reproduces ClimateStudio's solar exactly; zone temperatures still differ slightly between computers (see EnergyPlus foundation). |

**Machines and accounts.** Two Windows computers with Rhino 8 and Claude Code: a desktop with an NVIDIA GTX 1080 Ti and a laptop with a GTX 1660 Ti Max-Q. Both GPUs allow EnergyPlus's pixel-counting shading (so ClimateStudio's solar results can be reproduced exactly) and browser GPU computing. GitHub user `willemgirard03`; the repository will be public, suggested name `natural-ventilation-visualizer`. Because it is public, course-provided models and results stay out of it: the code refers to files in `A2` by path. A permissive code license such as MIT suits a public tool; choose it during setup. No Carbonfly (LGPL) code is copied, only published values.

**First Claude Code task: set up the repository (done 20 Oct).** The repository is `E:\ARCH 540\A2\natural-ventilation-visualizer`, inside `A2` rather than beside it; only this folder is published, and the rest of `A2` stays local and read-only. It is public at https://github.com/willemgirard03/natural-ventilation-visualizer under the MIT license, with a `.gitignore` that excludes EnergyPlus results, Rhino/Grasshopper models and archives. Commits use the GitHub noreply email. The drive records no file ownership, so each computer needs `git config --global --add safe.directory "E:/ARCH 540/A2/natural-ventilation-visualizer"` once (adjust the drive letter), plus `gh auth login`. Checked on the laptop on 20 Oct (`SESSION_CHECK.md`). There the name and noreply email are set in the repository's own config, because the laptop's global identity is used by other projects. The original steps:

1. Install Git and create a GitHub account (or sign in).
2. Create the repository folder on the drive, e.g. `E:\ARCH 540\natural-ventilation-visualizer`, separate from `A2`.
3. Add `PLAN.md`, a short `README.md`, a `.gitignore` and a license file.
4. Bring in the work from this chat: the 2D prototype (`section-airflow.html`), the ClimateStudio inspection scripts (`cs_desktop_kit`), and the EnergyPlus comparison script (`compare_eso.py`).
5. Keep large files out of the repository. GitHub rejects files over 100 MB, and the results folders hold a 984 MB shading file and 40–150 MB `.eso` files. The repository refers to them by path in `A2` instead; only small test inputs (`.epJSON`, weather files) may be copied in.
6. First commit and push, then a quick check that a second computer can clone it.

**Then phase 2,** starting with the automated alignment test: run EnergyPlus on the Example\_02 `.epJSON`, compare with ClimateStudio's `.eso`, and report the result. This repeats the sandbox test on your own computer. **Done 20 Oct on the desktop:** passed for Example\_02 and, ahead of schedule, for Example\_01; see EnergyPlus foundation.

**Running EnergyPlus on each computer.** The master copy is `E:\ARCH 540\tools\EnergyPlus-23.1.0` (the portable zip, 635 MB unpacked), but EnergyPlus cannot run from the exFAT drive, so each computer runs a local copy at `C:\EnergyPlus-23.1.0`. Only what a run and the Python API need is copied: the top-level program files, `pyenergyplus` and `python_standard_lib`, about 125 MB, taking about 5 seconds. Examples, documentation and pre/post-processors are left out, because the desktop's C: drive has only about 8 GB free. `tools/run_alignment.py` makes this copy itself the first time it runs on a computer that lacks it, and checks the build before every run; `--energyplus` or the `EPLUS_DIR` environment variable point it elsewhere. Large outputs (`.eso`, the ~1 GB shading CSV, which the script deletes unless `--keep-shading` is given) are written to `runs/` on the project drive, which Git ignores.

**On the laptop, once:** set the Git name and email (`git config --global user.name` / `user.email`, as on the desktop), install the GitHub CLI and sign in (`winget install --id GitHub.cli -e`, then `gh auth login --hostname github.com --git-protocol https --web`), trust the repository folder (`git config --global --add safe.directory "E:/ARCH 540/A2/natural-ventilation-visualizer"`, adjusting the drive letter), run `git pull`, then `%USERPROFILE%\.rhinocode\py39-rh8\python.exe tools\run_alignment.py example02`. The first run copies EnergyPlus to C:; a pass on the laptop also shows how close a third computer comes.

## Milestones and open questions

Four phases, each ending at a gate the next phase depends on. Phase ends follow the review dates in the schedule below.

&#91;embedded content: roadmap · 4 phases, 3 gates\]

The results folders replaced the licensed desktop session: ClimateStudio's EnergyPlus input files provide the settings, and its outputs provide the comparison data.

**Schedule to 10 December.** User reviews on 12 November, 27 November and 3 December set the phase ends, with peer reviews between them.

| Dates | Work | Ends with |
| --- | --- | --- |
| 17–26 Oct | Repository setup; Example\_02 `.epJSON` importer (done 20 Oct); EnergyPlus runner and the alignment test on your own computer (GPU, so exact shading; done 20 Oct); 3D view of the imported zones (done 20 Oct) | — |
| 27 Oct – 11 Nov | Network solver for the whole building, following EnergyPlus's airflow network method (done 20 Oct); the tool writes an airflow-network `.epJSON` and runs EnergyPlus to check it (done 20 Oct); window interpretation, casement default, awning stress test (done 21 Oct); first whole-building particle view from network flows (done 21 Oct) | User review 1 (12 Nov): Example\_02 imported, EnergyPlus alignment shown, airflow paths through the building |
| 12–26 Nov | 3D grid solver for the big moves (double-height office, stairwell) with particles (first version 21 Oct, whole building, with heat gains); plan and section slices; heat gains from people, lights and equipment; CO2 checked against Example\_02 | User review 2 (27 Nov) |
| 27 Nov – 2 Dec | Comfort readouts in rooms; model checks; atrium variant of Example\_02 checked against EnergyPlus; fixes from reviews | User review 3 (3 Dec) |
| 3–10 Dec | Example\_01 as the advanced check; documentation; demo; final fixes | Final deadline (10 Dec) |
| After 10 Dec | Rhino live sync and write-back, measured occupancy schedules, pressure coefficient export, Carbonfly comparison, possible pilot with the January class | — |

**Open questions**

- [x] What does Deconstruct CS Energy Model output? Classified geometry only (fourteen categories), not settings or results; and without a license the ClimateStudio components do not compute at all.
- [x] Which ClimateStudio version produced the runs? 2.2.9338, using EnergyPlus 23.1.0-87ed9199d4.
- [x] Sensible share of metabolic heat? EnergyPlus calculates it (sensible heat fraction set to autocalculate).
- [x] Does ClimateStudio model CO2? Yes, always; reporting it is optional (Example\_02 reports it).
- [x] Which weather file did the runs use? `CAN_BC_Vancouver_Intl_AP_718920_TDY-CWEC2020v2.epw`.
- [x] Where is sash type stored? Saved in the tool and written back to the Rhino window objects (lower priority).
- [x] Default sash type? Casement; awning as the stress test.
- [x] What should the tool answer first? Whole-building strategies (atria, stacks) and their effect on room comfort.
- [x] Primary validation case? Example\_02, with Example\_01 as the advanced check.
- [x] Who is it for? Architecture students anywhere; a January ClimateStudio course is a likely first audience.
- [x] Code license for the public repository? MIT, copyright Willem Girard (chosen 20 Oct at repository setup).
- [ ] Where EnergyPlus runs for other students (local install or a server); decide after review 1. The dev server's rerun (21 Oct) is the local route, working on any computer with EnergyPlus on an internal drive.
- [ ] Target student laptops: measure solver speed on the GTX 1660 Ti laptop before choosing grid resolution defaults.

## Reference library

Everything this plan relies on, so each claim can be traced. Statements not traceable to a row here come from general knowledge and are marked "unverified" in the text.

**ClimateStudio documentation**

| Page | Used for | Read |
| --- | --- | --- |
| [Thermal Zone Settings](https://climatestudiodocs.com/docs/thermalZoneSettings.html) | People density, metabolic rate, schedules, natural ventilation methods, AirflowNetwork override, the seven construction types | Yes |
| [Zone](https://climatestudiodocs.com/docs/thermal_zone.html) | Zone geometry rules (closed solids, touching neighbours) | Yes |
| [Windows](https://climatestudiodocs.com/docs/thermal_window.html) | Window geometry and ventilation settings (operable fraction, opening temperature) | Yes |
| [Thermal Model](https://climatestudiodocs.com/docs/thermalModel.html) | Separate thermal model convention | Yes |
| [Thermal Analysis](https://climatestudiodocs.com/docs/thermalAnalysis.html) | Simulation workflow; listed zone outputs (no CO2) | Yes |
| [Schedule Editor](https://climatestudiodocs.com/docs/scheduleEditor.html) | 8,760-hour schedules, day schedules, clipboard import | Yes |
| [Manage Library](https://climatestudiodocs.com/docs/manageLibrary.html) | Templates, materials, constructions; CSV export and import | Yes |
| [EnergyPlus Simulation Settings](https://climatestudiodocs.com/docs/EnergyPlus.html) | Three airflow modes, timestep, terrain wind correction, ground temperatures | Via research report only |
| [Results Panel](https://climatestudiodocs.com/docs/results.html) | `.CSR` result files, CSV export | Via research report only |
| [Grasshopper Workflow Templates](https://climatestudiodocs.com/docs/grasshopperTemplates.html) | Natural Ventilation and Airflow Network Model templates | Via research report only |
| [Shading](https://climatestudiodocs.com/docs/thermal_shading.html#shading) | Shading objects | Not yet |
| [Ground and adiabatic boundary conditions](https://climatestudiodocs.com/docs/thermal_boundaryConditions.html) | Ground and adiabatic surfaces | Partly (summary on Thermal Zone Settings) |

**Rhino and Grasshopper files**

| File | Contents | Used for |
| --- | --- | --- |
| CS\_Building\_Model.3dm | 47 zone solids on `CS::<Floor>::<Zone>` layers, 85 glazing planes, ground, topography, shading | Test building; geometry and layer conventions |
| CS\_Simulation.gh | Full ClimateStudio thermal pipeline: CS Intersector, CS Energy Zone, CS Window, Internal Window, CS Boundary Object, CS Model Maker, Deconstruct CS Energy Model; natural ventilation and HVAC settings as JSON | Pipeline to replicate; source of settings |
| Assemblies.gh | Get CS Material, Construct CS Layer, Construct CS Construction | Manual construction workflow to mirror |

**Other**

| Item | Used for |
| --- | --- |
| deep-research-report.md (ChatGPT deep research, October 2026) | ClimateStudio internals with confidence labels; confirms the three airflow modes and that most internals are not public |
| [EnergyPlus airflow reference](https://bigladdersoftware.com/epx/docs/22-1/input-output-reference/group-airflow.html) and [airflow network reference](https://bigladdersoftware.com/epx/docs/22-1/input-output-reference/group-airflow-network.html) | Equations behind ClimateStudio's ventilation modes (via research report) |
| [McNeel Discourse: window does not fit into any parent surface](https://discourse.mcneel.com/t/window-4-does-not-fit-into-any-parent-surface/150302) | Example window-parenting error (via research report) |
| [MDPI Atmosphere 9(3):113](https://www.mdpi.com/2073-4433/9/3/113) | Pressure coefficients from wind and context; airflow network concept |
| [Section airflow prototype](https://claude.ai/artifact/V7BKiPBqGzpKDNRDRbCRME) | Phase 1 solver and renderer |
| Fast Fluid Dynamics papers (Zuo and Chen), FluidX3D, Carbonfly, Eddy3D | Solver approach and validation tools, found by web search earlier in this project |
| Carbonfly repository (github.com/RWTH-E3D/carbonfly), read directly | CO2 generation table, breathing defaults, air quality bands, Maas window formula, EN 1991-1-4 pressure coefficients; CO2 validation reference |
| Persily and de Jonge (2017), Carbon dioxide generation rates for building occupants, Indoor Air 27(5) | Original source of the CO2 generation table (cited by Carbonfly; not yet read directly) |
| CS\_Results.zip (Willem\_Girard\_CS\_V3 results folder) | ClimateStudio's full EnergyPlus input (.idf, .epJSON) and hourly outputs (.eso) for a simple-airflow run; source of the Findings section |
| EnergyPlus repository (github.com/NatLabRockies/EnergyPlus) and documentation (energyplus.readthedocs.io) | The reference engine: input objects, equations, Python API; BSD-3-like license |
| ASHRAE Global Occupant Behavior Database (ashraeobdatabase.com), obplatform package, data.zip (studies 8 and 9) | Measured occupancy, window and lighting behaviour; API for querying studies |
| Example\_02.zip (2226\_Emmenweid: .3dm, .gh and results folder) | Lighter validation case (12 zones) with hourly CO2 results |
| Vancouver weather files: TDY-CWEC2020v2 (matches both runs), CWEC2020v2, TMYx 2004–2018, morphed SSP5-8.5 2040s/2050s/2060s | Weather input for EnergyPlus runs; the morphed files allow future-climate comparisons |
| Scripts written in this chat: cs\_desktop\_kit (component dump, object probe, EnergyPlus capture and input summarizer), compare\_eso.py | Inspecting ClimateStudio Grasshopper components; summarizing .idf/.epJSON files; comparing two EnergyPlus runs output by output |
