// Writes the project model back to EnergyPlus .epJSON.
//
// Nothing in the model can be edited yet, so the export is the imported objects unchanged.
// When overrides arrive (PLAN.md, Data model), they are applied to this copy before writing.

export function exportEpJSON(model) {
  return structuredClone(model.epjson);
}

export function serializeEpJSON(epjson) {
  return JSON.stringify(epjson, null, 2);
}
