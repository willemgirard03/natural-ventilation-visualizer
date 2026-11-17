// A length typed in any unit, by its suffix: a bare number is millimetres; mm, cm, m (or metre, metres,
// meter, meters); in, inch, inches or "; ft, foot, feet or '. Feet and inches together (5' 6", 5ft 6in,
// 5' 6 1/2") add up, and a fraction (1/2, 3 1/4) is taken where a number is. A sign at the front holds
// for the whole. Returns metres, or null when it cannot be read.

const UNIT = {
  mm: 0.001, millimetre: 0.001, millimetres: 0.001, millimeter: 0.001, millimeters: 0.001,
  cm: 0.01, centimetre: 0.01, centimetres: 0.01, centimeter: 0.01, centimeters: 0.01,
  m: 1, metre: 1, metres: 1, meter: 1, meters: 1,
  in: 0.0254, inch: 0.0254, inches: 0.0254, '"': 0.0254, '″': 0.0254, "''": 0.0254,
  ft: 0.3048, foot: 0.3048, feet: 0.3048, "'": 0.3048, '′': 0.3048,
};

export function parseLength(text, bare = 0.001) {
  let t = String(text).trim().toLowerCase().replace(/,/g, '.');
  if (!t) return null;
  let sign = 1;
  if (/^[-−]/.test(t)) { sign = -1; t = t.slice(1).trim(); } else if (t.startsWith('+')) t = t.slice(1).trim();
  // a number (with a fraction, or a whole and a fraction) and its unit, again and again
  const re = /^(\d+(?:\.\d*)?|\.\d+)(?:\s+(\d+)\/(\d+)|\/(\d+))?\s*(millimet(?:re|er)s?|centimet(?:re|er)s?|met(?:re|er)s?|inch(?:es)?|feet|foot|mm|cm|in|ft|m|''|["″'′])?\s*/;
  let total = 0, n = 0, lastFeet = false;
  while (t.length) {
    const m = re.exec(t);
    if (!m) return null;
    let v = Number(m[1]);
    if (m[2]) v += Number(m[2]) / Number(m[3]);
    if (m[4]) v = Number(m[1]) / Number(m[4]);
    // a number with no unit after feet is inches (5' 6); else it is the bare unit
    const unit = m[5] ? UNIT[m[5]] : n && lastFeet ? UNIT.in : bare;
    lastFeet = unit === UNIT.ft;
    total += v * unit;
    n++;
    t = t.slice(m[0].length);
  }
  return n ? sign * total : null;
}

// Whether text is starting to be a length (digits, then any unit characters): for keys typed while
// drawing, which go to the length rather than elsewhere once a number has begun.
export const lengthChar = (c, typed) => (typed ? /^[0-9.,a-z'"″′ /-]$/i.test(c) : /^[0-9.,-]$/.test(c));
