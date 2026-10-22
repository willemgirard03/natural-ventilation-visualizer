// Expands an EnergyPlus schedule into 8,760 hourly values (non-leap year).
// Supports the types ClimateStudio writes: Schedule:Constant and
// Schedule:Year -> Schedule:Week:Daily -> Schedule:Day:Hourly.

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const SUPPORTED_SCHEDULE_TYPES = ['Schedule:Constant', 'Schedule:Year'];

function dayOfYear(month, day) {
  let n = day - 1;
  for (let m = 0; m < month - 1; m++) n += DAYS_IN_MONTH[m];
  return n;
}

export function scheduleType(epjson, name) {
  for (const type of ['Schedule:Constant', 'Schedule:Year', 'Schedule:Compact', 'Schedule:File', 'Schedule:Week:Daily', 'Schedule:Day:Hourly']) {
    if (epjson[type] && epjson[type][name]) return type;
  }
  return null;
}

// Weekday of 1 January, 0 = Sunday, from the first RunPeriod (EnergyPlus default: Sunday).
function startWeekday(epjson) {
  const rp = epjson.RunPeriod && Object.values(epjson.RunPeriod)[0];
  const i = rp ? WEEKDAYS.indexOf(String(rp.day_of_week_for_start_day || 'Sunday').toLowerCase()) : 0;
  return i < 0 ? 0 : i;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// Day of the year (0-based) of a RunPeriodControl date: "3/10", "March 10", "10 March",
// "2nd Sunday in March" or "Last Sunday in October". Null if it cannot be read.
function dateDay(text, first) {
  const s = String(text).trim().toLowerCase();
  let m = s.match(/^(\d{1,2})\s*\/\s*(\d{1,2})$/);
  if (m) return dayOfYear(+m[1], +m[2]);
  m = s.match(/^([a-z]+)\s+(\d{1,2})$/) || s.match(/^(\d{1,2})\s+([a-z]+)$/);
  if (m) {
    const [month, day] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    const mi = MONTHS.findIndex((n) => n.startsWith(month.slice(0, 3)));
    return mi < 0 ? null : dayOfYear(mi + 1, +day);
  }
  m = s.match(/^(1st|2nd|3rd|4th|5th|last)\s+([a-z]+)\s+in\s+([a-z]+)$/);
  if (!m) return null;
  const wd = WEEKDAYS.indexOf(m[2]), mi = MONTHS.findIndex((n) => n.startsWith(m[3].slice(0, 3)));
  if (wd < 0 || mi < 0) return null;
  const d0 = dayOfYear(mi + 1, 1), firstMatch = d0 + ((wd - (first + d0) % 7 + 7) % 7);
  if (m[1] !== 'last') return firstMatch + 7 * (parseInt(m[1], 10) - 1);
  let d = firstMatch;
  while (d + 7 < d0 + DAYS_IN_MONTH[mi]) d += 7;
  return d;
}

// Days of the year (0-based, inclusive) under daylight saving time, or null. EnergyPlus reads every
// schedule one hour ahead on those days, while the weather file and results stay in standard time.
export function daylightSavingDays(epjson) {
  const c = epjson['RunPeriodControl:DaylightSavingTime'] && Object.values(epjson['RunPeriodControl:DaylightSavingTime'])[0];
  if (!c) return null;
  const first = startWeekday(epjson);
  const a = dateDay(c.start_date, first), b = dateDay(c.end_date, first);
  return a == null || b == null ? null : [a, b];
}

// Returns a Float64Array(8760) indexed by standard-time hour (as the weather file and results are),
// or null if the schedule is missing or of an unsupported type.
export function hourlyValues(epjson, name) {
  const type = scheduleType(epjson, name);
  if (type === 'Schedule:Constant') {
    return new Float64Array(8760).fill(epjson[type][name].hourly_value);
  }
  if (type !== 'Schedule:Year') return null;

  const out = new Float64Array(8760);
  const weeks = epjson['Schedule:Week:Daily'] || {};
  const days = epjson['Schedule:Day:Hourly'] || {};
  const first = startWeekday(epjson);
  for (const w of epjson[type][name].schedule_weeks) {
    const week = weeks[w.schedule_week_name];
    if (!week) return null;
    const d0 = dayOfYear(w.start_month, w.start_day);
    const d1 = dayOfYear(w.end_month, w.end_day);
    for (let d = d0; d <= d1; d++) {
      const day = days[week[`${WEEKDAYS[(first + d) % 7]}_schedule_day_name`]];
      if (!day) return null;
      for (let h = 0; h < 24; h++) out[d * 24 + h] = day[`hour_${h + 1}`];
    }
  }
  const dst = daylightSavingDays(epjson);
  if (dst) for (let i = dst[0] * 24; i < Math.min(8759, dst[1] * 24 + 24); i++) out[i] = out[i + 1];
  return out;
}
