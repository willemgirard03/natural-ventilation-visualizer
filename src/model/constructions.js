// Construction properties from material layers, ordered outside to inside:
//   R = sum(t / k)        thermal resistance of the layers, m2.K/W, without surface films
//   C = sum(rho * c * t)  heat capacity per unit area, J/m2.K
//   T = sum(t)            total thickness, m

export const LAYER_FIELDS = ['outside_layer', ...Array.from({ length: 9 }, (_, i) => `layer_${i + 2}`)];

const OPAQUE = ['Material', 'Material:NoMass', 'Material:AirGap', 'Material:InfraredTransparent'];
const GLAZING = ['WindowMaterial:SimpleGlazingSystem', 'WindowMaterial:Glazing', 'WindowMaterial:Gas',
  'WindowMaterial:GasMixture', 'WindowMaterial:Shade', 'WindowMaterial:Blind', 'WindowMaterial:Screen'];

function findMaterial(epjson, name) {
  for (const type of [...OPAQUE, ...GLAZING]) {
    if (epjson[type] && epjson[type][name]) return { type, fields: epjson[type][name] };
  }
  return null;
}

function layerProperties({ type, fields: f }) {
  switch (type) {
    case 'Material':
      return { thickness: f.thickness, R: f.thickness / f.conductivity, C: f.density * f.specific_heat * f.thickness };
    case 'Material:NoMass':
    case 'Material:AirGap':
      return { thickness: 0, R: f.thermal_resistance, C: 0 };
    case 'Material:InfraredTransparent':
      return { thickness: 0, R: 0, C: 0 };
    default: // glazing layers: thickness only; U-value needs EnergyPlus's window calculation
      return { thickness: f.thickness || 0, R: null, C: null };
  }
}

// Returns { name, layers, glazing, thickness, R, C, uFactor, shgc, visibleTransmittance, missingLayers }.
export function constructionProperties(epjson, name) {
  const c = epjson.Construction && epjson.Construction[name];
  if (!c) return null;
  const layers = [], missingLayers = [];
  for (const field of LAYER_FIELDS) {
    if (!c[field]) continue;
    const m = findMaterial(epjson, c[field]);
    if (!m) { missingLayers.push(c[field]); continue; }
    layers.push({ name: c[field], type: m.type, ...layerProperties(m) });
  }
  const glazing = layers.some((l) => GLAZING.includes(l.type));
  const sum = (key) => layers.reduce((s, l) => (s === null || l[key] === null ? null : s + l[key]), 0);
  const result = { name, layers, glazing, thickness: sum('thickness'), R: glazing ? null : sum('R'), C: glazing ? null : sum('C'), missingLayers };
  const simple = layers.find((l) => l.type === 'WindowMaterial:SimpleGlazingSystem');
  if (simple) {
    const f = epjson['WindowMaterial:SimpleGlazingSystem'][simple.name];
    Object.assign(result, { uFactor: f.u_factor, shgc: f.solar_heat_gain_coefficient, visibleTransmittance: f.visible_transmittance });
  }
  return result;
}
