// Removes the objects in an EnergyPlus model that run code of their own: Python plugins, the
// Energy Management System's programs and external interfaces (co-simulation, FMUs). A runner
// on someone's computer takes models from a web page, and any page could post one; the tool's
// own models never contain them.

const CODE = [/^PythonPlugin:/, /^EnergyManagementSystem:/, /^ExternalInterface/];

// Returns { epjson, removed }: a copy without those objects, and the object types taken out.
export function stripCode(epjson) {
  const out = {}, removed = [];
  for (const [type, objects] of Object.entries(epjson)) {
    if (CODE.some((re) => re.test(type))) removed.push(type);
    else out[type] = objects;
  }
  return { epjson: out, removed };
}
