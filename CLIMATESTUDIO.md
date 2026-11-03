# ClimateStudio: what it does, and what the tool takes from it

A reference for the Natural Ventilation Visualizer. ClimateStudio is never a dependency of the tool: it is a validation reference during development, and compatibility is one way (the tool reads ClimateStudio's `.epJSON`, `.eso` and `.epw`; nothing goes back). This file collects what ClimateStudio 2.2 (EnergyPlus 23.1) does, from its results folders, its Grasshopper components (read with a licence on 3 Nov 2026) and its own interface (screenshots, 3 Nov), so the tool can model a building from scratch the same way where that matters, and better where it can. Its interface does not need copying; its behaviour does need to be understood.

Status column: **has** (the tool does it), **part** (some of it), **not yet**, **no** (out of scope).

## Workflow (the Thermal Analysis panel)

ClimateStudio's thermal workflow is four steps in order, each a tab:

| Step | What it sets | Tool |
| --- | --- | --- |
| Location | The weather file (e.g. Vancouver.Intl.AP), which also sets the site | has (weather file) |
| Energy Sources and Emission Factors | A table of fuels (electricity, natural gas, fuel oils, coal, gasoline, propane, diesel, wood pellets, a custom fuel): primary energy factor, CO₂ in kg/MWh, price in cent/kWh | not yet (energy use is not the tool's aim; useful if heating and cooling are reported later) |
| Add objects | Zones, windows, shading, ground boundaries and adiabatic boundaries, listed with their visibility, window-to-wall ratio, space use, construction and system | part (zones, windows and shading are read and edited; boundaries are not set by hand yet) |
| Assign Zones to Systems | Which ideal-loads system each zone belongs to | not yet (the tool reads the systems) |

A ground boundary ("Default Ground Boundary") and adiabatic boundaries are objects of their own: a zone face touching one becomes ground contact or adiabatic. Ground contact is not worked out from height.

## Zones

A zone is a closed solid with a name, and four settings:

| Setting | Contents | Tool |
| --- | --- | --- |
| Building type and space use | A **space-use template** chosen by building type (MediumOffice …) from a library of templates by standard (ClimateStudio's own with SIA Merkblatt sources, ASHRAE 90.1-2019, NECB 2020, DOE prototypes) | part (the zone's loads are edited; no template library) |
| Construction | A **construction template**: an assembly for each surface class, plus infiltration, internal mass, foundation and the exterior window | part (assemblies one by one; no templates) |
| WWR | **Window-to-wall ratio**: "Uniform" with an overall ratio (e.g. 0.4), windows made automatically on every facade | not yet: worth having in massing |
| System | The ideal-loads system it belongs to | part |

### Space use (loads and conditioning)

- **People:** density (people/m²), metabolic rate (met), occupancy schedule, air-speed schedule (m/s), clothing (Dynamic Clothing Model ASHRAE 55), on/off. Tool: density and schedule (has); metabolic rate shown (part); air speed and clothing (not yet, needed for comfort readouts).
- **Equipment:** power density (W/m²), availability schedule, on/off. Tool: density (has); schedule (shown).
- **Lighting:** power density (W/m²), availability schedule, illuminance target (lux), dimming type (Off, Continuous …), on/off. Tool: density (has); dimming and target (not yet; daylight is out of scope).
- **Hot water:** COP, flow per person, schedule. Tool: no.
- **Thermostat:** heating and cooling setpoints, each constant or a schedule. Tool: not yet (read through the systems, not edited).
- **Mechanical ventilation:** minimum fresh air per person (L/s·p) and per floor area (L/s·m²). Tool: has.
- Templates read: e.g. "90.1-2019 MediumOffice – OpenOffice" (0.0565 p/m², 1.2 met, 10.33 W/m² equipment, 6.57 W/m² lighting, schedules `OfficeMedium BLDG_OCC_SCH`, `BLDG_EQUIP_SCH_2013`, `BLDG_LIGHT_SCH_2013`); ClimateStudio's own "Office" (0.071 p/m², 7 W/m², 16 W/m², 500 lux, 20/26 °C, 10 L/s·p + 1 L/s·m²).

### Schedules

Each schedule has a name, category (Occupancy …), standard, program, type (Fraction …), and hours in use a year; the viewer shows a day's profile and a year heat map. Year schedules are built from day schedules (Schedule:Year → Week:Daily → Day:Hourly in the `.epJSON`). Tool: reads them (has), shows a zone's day as bars (has), picks a schedule (has); a year view and editing schedules (not yet).

ClimateStudio writes per-zone control schedules: `MechVentAvail_<zone>` is the occupancy schedule; `HeatAvail_`/`CoolAvail_` are always on (the system switches heating and cooling off); `NatVentAvail_<zone>` is worked out from the weather file: on in the hours whose outdoor air is between the natural-ventilation limits (10–27 °C, at most 90% humidity in the examples).

### Construction template

| Part | Contents | Tool |
| --- | --- | --- |
| Assemblies by class | Roof, Facade, Partition, Slab (interior floor), External Floor, Ground Slab, Ground Wall, each with U-value and thermal capacitance (kJ/m²K) | part (assemblies swapped and edited; R and U shown; capacitance not shown) |
| Additional internal mass | On/off, an assembly and exposed area per floor area | not yet |
| Infiltration | Air changes per hour, or flow per exterior area; advanced options (temperature and wind coefficients); an airflow-network crack coefficient | part (ach edited) |
| Foundation | Ground model (GroundTemperature …), F- and C-factors, insulation | no |
| Zone behaviour | Zone priority; inside and outside surface convection models (TARP, DOE2, MoWiTT, SimpleCombined, Adaptive); **roof tilt 45° and floor tilt 135°** (a face is a roof below 45° of tilt, a floor above 135°, a wall between); workplane height; daylight mesh | the tilt rule: to use in massing; the rest not yet |
| Exterior window | Glazing (simple glazing model: U-value, SHGC, visible transmittance; or layered glass and gas), shading system (type, control, schedule, set point, transmittance), **ventilation settings** (operable area 0.8, discharge coefficient 0.65, airflow-network temperature set point 20 °C, availability, vent control "Temperature", an optional array of wind pressure coefficients), window frame | part (operable fraction and sash type; glazing shown; no shading system or frame) |

### Constructions library

Each assembly is drawn in section, outside or top first, with its layers numbered and listed (material, thickness), its U-value, R-value, thermal capacitance, embodied energy (MJ/m²) and embodied carbon (kg CO₂/m²), type, standard, climate zone, data source (e.g. DOE Commercial Prototype Buildings), and a lock on library items. Windows have a simple glazing model (U, SHGC, Tvis) or layers. Tool: the Materials and assemblies window and the surface pop-up draw and edit assemblies (has); thermal capacitance, embodied energy and carbon, and a library of standard assemblies (not yet).

## Systems: Ideal Air Loads

| Group | Settings | Tool |
| --- | --- | --- |
| Heating | On/off, COP, energy source, availability schedule, sizing factor, maximum supply air temperature | not yet |
| Cooling | On/off, COP, energy source, availability, sizing factor, minimum supply air temperature | not yet |
| Humidity control | On/off, maximum and minimum relative humidity | not yet |
| Mechanical ventilation | On/off, availability schedule, heat recovery (type, sensible and latent efficiency), economizer, EMS fan energy and fan pressure rise | part (outdoor air per person and area) |
| Natural ventilation | On/off, set point (opens above it), schedule, minimum and maximum outdoor temperature, maximum humidity, a mode ("Natural Ventilation" …), **stack-driven flow** and **cross-ventilation** switches | part (the opening set point is edited; the network replaces the simple stack and wind model) |

Example\_02 runs free-running: heating and cooling off, mechanical ventilation on the occupancy schedule, natural ventilation by buoyancy and wind above 25 °C, outdoor air 10–27 °C, at most 90% humidity.

## Simulation settings

Read from its run settings (CSEnergyModelSettings): heat balance method, timestep (6 an hour), shading calculation (pixel counting on the GPU), solar distribution, sky model, terrain (Suburbs …), wind and air-temperature sensor heights, north angle, run period, ground temperatures and reflectance, output resolution, requested outputs and meters, ambient CO₂ schedule, building type, and **AirflowMode**: Simple (wind-and-stack, as the examples), AirflowNetwork, or AirflowNetworkWithCP. Tool: the runner writes the tool's own airflow network (has); run period week or year (has).

### Its airflow network (AirflowNetwork mode)

Cracks on walls only (each shared wall once, and the facades; none on floors, ceilings or roofs), 0.001 kg/s at 1 Pa, exponent 0.65; each window a simple opening (discharge coefficient 0.65, closed leakage 0.001), opened to the operable area under temperature control with a minimum venting factor of 0.3; no interior doors; the building taken as square and facing north (azimuth 0, ratio 1) for the wind pressures. The tool solves a model that carries this network with it, within 0.02% of EnergyPlus (PLAN.md).

## Geometry, classification and names

- Massing is one closed solid per zone; windows are separate surfaces lying on the facades.
- **CS Intersector** splits shared faces by what they touch (the double-height office's floor in Example\_02 becomes four pieces, one over each room below), each piece paired with the other zone's piece.
- Classification by tilt (45°, 135°) and by boundary objects (ground, adiabatic).
- Facades are written gross, windows as subsurfaces (EnergyPlus subtracts them); ClimateStudio's own classified output is net.
- Names: a zone is its typed name plus its index (`GF_Office_1_0`); a surface `zone:f<n>` (n, the face's number in the split solid); a window `zone:f<n>:w<k>`.

## Its Grasshopper components (for test models)

CS Intersector, CS Energy Zone (Brep, name, zone setting), CS Window (surfaces, settings as JSON), CS Boundary Object (a hidden kind, GROUND or ADIABAT, adiabatic when new), CS Shading Object, IAL System (zones, settings as JSON), CS Model Maker (systems, windows, boundaries, shading, library, extra IDF text), Deconstruct CS Energy Model, Run CS Energy Model, Get CS Space Use Template, Get CS Construction (Template), Get CS Material, Construct CS Construction. A test model built from these classifies correctly, but would not run from a script (3 Nov); test models are therefore written by the tool in ClimateStudio's manner and run in EnergyPlus directly.

## Features the tool did not have, gathered here (3 Nov)

From the interface, beyond what the files showed:

1. **Window-to-wall ratio** windows ("Uniform", overall ratio): a fast way to glaze a massing.
2. **Space-use and construction templates** chosen by building type and standard, with a library of them.
3. **Thermostat set points** constant or scheduled, edited per space use.
4. **Air speed and clothing** for thermal comfort (needed for the comfort readouts).
5. **Thermal capacitance, embodied energy and embodied carbon** of assemblies.
6. **Internal mass** and **foundation** settings.
7. **Surface convection models** and **zone priority**.
8. **Window shading systems and frames.**
9. **Humidity control, heat recovery and economizer** in the system.
10. **Natural-ventilation mode switches**: stack-driven flow and cross-ventilation.
11. **Energy sources and emission factors** (primary energy, CO₂, price).
12. **Schedule year view** (heat map) and a schedule library by category, standard and program.
