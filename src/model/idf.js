// EnergyPlus's text input (.idf) read into epJSON, and epJSON written back as .idf, by the field map
// built from EnergyPlus's own schema (idd-fields.js, tools/build-idd.mjs). As EnergyPlus's
// ConvertInputFormat does it: object and choice names are not case sensitive in an IDF and take the
// schema's spelling; numeric fields become numbers (words such as Autosize stay words); empty fields are
// left out; an object's name is its key, and an object without one is keyed "<type> <n>"; a repeating
// group of fields (a surface's vertices, a schedule's data) is an array under the schema's key.
//
// parseIDF(text, idd) -> { epjson, unknown: [types not in the schema], count }
// writeIDF(epjson, idd) -> text

// The IDF split into objects, each a list of its fields (the type first); comments (from !) dropped.
function objectsOf(text) {
  const out = [];
  let fields = [], cur = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/!.*$/, '');
    for (const ch of line) {
      if (ch === ',') { fields.push(cur.trim()); cur = ''; }
      else if (ch === ';') { fields.push(cur.trim()); cur = ''; if (fields.some((f) => f !== '')) out.push(fields); fields = []; }
      else cur += ch;
    }
    cur += ' ';
  }
  return out;
}

export function parseIDF(text, idd) {
  const byLower = new Map(Object.keys(idd.types).map((t) => [t.toLowerCase(), t]));
  const epjson = {}, unknown = new Set(), counts = {};
  let count = 0;
  for (const [typeRaw, ...vals] of objectsOf(text)) {
    const type = byLower.get(typeRaw.toLowerCase());
    if (!type) { unknown.add(typeRaw); continue; }
    const T = idd.types[type], obj = {}, nset = new Set(T.n || []), xnset = new Set(T.xn || []);
    const value = (v, numeric, field) => {
      if (v === '') return undefined;
      if (numeric && /^[-+]?(\d+\.?\d*|\.\d+)([eEdD][-+]?\d+)?$/.test(v)) return Number(v.replace(/[dD]/, 'e'));
      const ch = T.c?.[field];
      if (ch) { const hit = ch.find((c) => c.toLowerCase() === v.toLowerCase()); if (hit) return hit; }
      return v;
    };
    let name = null;
    T.f.forEach((f, i) => {
      const v = value(vals[i] ?? '', nset.has(i), f);
      if (v === undefined) return;
      if (f === 'name' && T.named) name = String(v); else obj[f] = v;
    });
    if (T.x && vals.length > T.f.length) {
      const rest = vals.slice(T.f.length), n = T.x.length, list = [];
      for (let k = 0; k < rest.length; k += n) {
        const item = {};
        T.x.forEach((f, j) => { const v = value(rest[k + j] ?? '', xnset.has(j), f); if (v !== undefined) item[f] = v; });
        if (Object.keys(item).length) list.push(item);
      }
      if (list.length) obj[T.e] = list;
    }
    counts[type] = (counts[type] || 0) + 1;
    const key = name ?? `${type} ${counts[type]}`;
    (epjson[type] ||= {})[key] = obj;
    count++;
  }
  return { epjson, unknown: [...unknown], count };
}

export function writeIDF(epjson, idd) {
  const lines = [`! Written by the Natural Ventilation Visualizer from epJSON, in EnergyPlus's IDF field order.`, ''];
  const num = (v) => (typeof v === 'number' ? String(+v.toPrecision(12)) : String(v));
  for (const [type, objs] of Object.entries(epjson)) {
    const T = idd.types[type];
    if (!T || !objs || typeof objs !== 'object') continue;
    for (const [key, o] of Object.entries(objs)) {
      const vals = T.f.map((f) => (f === 'name' && T.named ? key : o[f] === undefined ? '' : num(o[f])));
      if (T.x) for (const item of o[T.e] || []) vals.push(...T.x.map((f) => (item[f] === undefined ? '' : num(item[f]))));
      while (vals.length > 1 && vals[vals.length - 1] === '') vals.pop();
      const fields = vals.length ? vals : [''];
      lines.push(`${type},`);
      fields.forEach((v, i) => {
        const end = i === fields.length - 1 ? ';' : ',', label = i < T.f.length ? T.f[i] : T.x[(i - T.f.length) % T.x.length];
        lines.push(`  ${`${v}${end}`.padEnd(30)} !- ${label}`);
      });
      lines.push('');
    }
  }
  return lines.join('\n');
}
