// Writes the project model back to EnergyPlus .epJSON.
//
// Edits change the model's .epJSON objects directly (edit.js), so the export is those objects as
// they stand: unchanged when nothing was edited.

export function exportEpJSON(model) {
  return structuredClone(model.epjson);
}

export function serializeEpJSON(epjson) {
  return JSON.stringify(epjson, null, 2);
}
