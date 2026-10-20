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

// Returns a Float64Array(8760), or null if the schedule is missing or of an unsupported type.
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
  return out;
}
