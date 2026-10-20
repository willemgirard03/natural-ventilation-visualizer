// Air properties and site conditions as EnergyPlus 23.1 computes them (Psychrometrics,
// DataEnvironment and AirflowNetwork/Properties), so the tool's solver uses the same numbers.

export const KELVIN = 273.15;

// Moist air density (kg/m3) from pressure (Pa), dry-bulb temperature (degC) and humidity ratio (kg/kg).
export const density = (p, t, w) => p / (287.0 * (t + KELVIN) * (1.0 + 1.6078 * Math.max(w, 1e-5)));

// Dynamic viscosity of air (kg/m.s) at temperature t (degC), the AirflowNetwork's linear fit.
export const viscosity = (t) => 1.71432e-5 + 4.828e-8 * t;

// Standard barometric pressure at a site elevation (Pa).
export const standardPressure = (elevation) => 101325 * (1 - 2.25577e-5 * elevation) ** 5.2559;

// Gravity at a latitude (N/kg), used by EnergyPlus for stack pressures.
export function gravity(latitude) {
  const phi = (latitude * Math.PI) / 180;
  return 9.780373 * (1 + 0.0052891 * Math.sin(phi) ** 2 - 0.0000059 * Math.sin(2 * phi) ** 2);
}

// Terrain parameters (ASHRAE, as in EnergyPlus's Building object): wind profile exponent and
// boundary layer thickness (m).
export const TERRAIN = {
  Country: [0.14, 270], Suburbs: [0.22, 370], City: [0.33, 460], Ocean: [0.10, 210], Urban: [0.22, 370],
};

// The weather station's terrain and sensor height: EnergyPlus assumes open country with the wind
// sensor at 10 m unless the model has a Site:WeatherStation object. ClimateStudio writes one that
// puts the station in suburban terrain, which raises wind speeds at the building by 40%.
export function weatherStation(epjson = {}) {
  const s = Object.values(epjson['Site:WeatherStation'] || {})[0] || {};
  return {
    height: s.wind_sensor_height_above_ground ?? 10,
    exponent: s.wind_speed_profile_exponent ?? 0.14,
    boundaryLayer: s.wind_speed_profile_boundary_layer_thickness ?? 270,
  };
}

// Wind speed (m/s) at height z (m) above ground, from the weather file's wind speed.
export function windSpeedAt(z, metWindSpeed, terrain = 'Suburbs', station = weatherStation()) {
  if (z <= 0) return 0;
  const [exponent, boundaryLayer] = TERRAIN[terrain] || TERRAIN.Suburbs;
  return metWindSpeed * (station.boundaryLayer / station.height) ** station.exponent * (z / boundaryLayer) ** exponent;
}

// The weather file's dry-bulb temperature is measured 1.5 m above ground; EnergyPlus moves it to
// ground level with the standard lapse rate before using it for wind pressure.
export const GROUND_TEMPERATURE_OFFSET = (0.0065 * 6356766 * 1.5) / (6356766 + 1.5);
