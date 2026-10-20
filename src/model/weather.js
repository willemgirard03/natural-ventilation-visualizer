// Reads an EnergyPlus weather file (.epw): the site and the hourly conditions the airflow network
// needs. Each row is the hour ending at its time (hour 15 = 14:00 to 15:00), as in EnergyPlus.

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function parseEPW(text, { fileName = null } = {}) {
  const lines = text.split(/\r?\n/);
  const loc = lines[0].split(',');
  if (loc[0] !== 'LOCATION') throw new Error('not an EnergyPlus weather file (no LOCATION line)');
  const hours = [];
  for (const line of lines.slice(8)) {
    const f = line.split(',');
    if (f.length < 22) continue;
    hours.push({
      month: Number(f[1]), day: Number(f[2]), hour: Number(f[3]),
      t: Number(f[6]), dewPoint: Number(f[7]), relativeHumidity: Number(f[8]), pressure: Number(f[9]),
      windDirection: Number(f[20]), windSpeed: Number(f[21]),
    });
  }
  if (hours.length !== 8760) throw new Error(`expected 8,760 hours, found ${hours.length}`);
  return {
    fileName,
    location: { name: loc[1], region: loc[2], country: loc[3], latitude: Number(loc[6]), longitude: Number(loc[7]), timeZone: Number(loc[8]), elevation: Number(loc[9]) },
    hours,
  };
}

// Hour index (0 to 8759) from day of the year (1 to 365) and hour ending (1 to 24).
export const hourIndex = (dayOfYear, hour) => (dayOfYear - 1) * 24 + (hour - 1);

export function dateOf(dayOfYear) {
  let d = dayOfYear, m = 0;
  while (d > DAYS_IN_MONTH[m]) d -= DAYS_IN_MONTH[m++];
  return { month: m + 1, day: d, label: `${d} ${MONTHS[m]}` };
}

// Saturation vapour pressure (Pa) over water, or ice below 0 degC (ASHRAE Fundamentals, Hyland and Wexler).
export function saturationPressure(t) {
  const T = t + 273.15;
  if (t >= 0) {
    return Math.exp(-5.8002206e3 / T + 1.3914993 - 4.8640239e-2 * T + 4.1764768e-5 * T ** 2 - 1.4452093e-8 * T ** 3 + 6.5459673 * Math.log(T));
  }
  return Math.exp(-5.6745359e3 / T + 6.3925247 - 9.677843e-3 * T + 6.2215701e-7 * T ** 2 + 2.0747825e-9 * T ** 3 - 9.484024e-13 * T ** 4 + 4.1635019 * Math.log(T));
}

// Humidity ratio (kg water per kg dry air) from the dew point (degC) and pressure (Pa).
export function humidityRatio(dewPoint, pressure) {
  const pv = saturationPressure(dewPoint);
  return (0.621945 * pv) / (pressure - pv);
}

// Humidity ratio from dry-bulb temperature (degC), relative humidity (%) and pressure (Pa). EnergyPlus
// takes outdoor humidity this way, from the weather file's relative humidity, not its dew point.
export function humidityRatioFromRH(t, relativeHumidity, pressure) {
  const pv = (relativeHumidity / 100) * saturationPressure(t);
  return (0.621945 * pv) / (pressure - pv);
}

// The airflow network's outdoor conditions for one hour of the weather file.
export function outdoorAt(weather, dayOfYear, hour) {
  const h = weather.hours[hourIndex(dayOfYear, hour)];
  return { t: h.t, w: humidityRatioFromRH(h.t, h.relativeHumidity, h.pressure), pressure: h.pressure, windSpeed: h.windSpeed, windDirection: h.windDirection };
}
