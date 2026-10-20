"""
ClimateStudio component dump (desktop session 1, step 2)

Paste into a Grasshopper Python component (Rhino 8 "Python 3 Script" or
Rhino 7 "GhPython"; written to run on both).

Inputs (right-click the component to add them; leave type hint as default):
    run     bool   set True to write the files
    folder  str    output folder (optional; default: Desktop\\cs_dump)
    match   str    text to match in category, library name or file path
                   (optional; default: "ClimateStudio")

Outputs:
    report  str    short summary
    path    str    folder the files were written to

Writes:
    cs_components.json   every matching component and parameter, all fields
    cs_components.md     the same, readable

It only reads component definitions from Grasshopper's component server;
it does not run any simulation or change the document.
"""

import os
import json
import datetime

import Grasshopper as gh
import Rhino

try:
    run
except NameError:
    run = False
try:
    folder
except NameError:
    folder = None
try:
    match
except NameError:
    match = None


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def text(v):
    if v is None:
        return None
    try:
        return str(v)
    except Exception:
        return repr(v)


def param_info(p):
    info = {
        "name": safe(lambda: p.Name),
        "nickname": safe(lambda: p.NickName),
        "description": safe(lambda: p.Description),
        "type_name": safe(lambda: p.TypeName),
        "type_full": safe(lambda: p.Type.FullName),
        "access": text(safe(lambda: p.Access)),
        "optional": safe(lambda: bool(p.Optional)),
        "param_class": safe(lambda: p.GetType().FullName),
        "defaults": [],
    }
    # Persistent (default) data, if the parameter carries any
    pd = safe(lambda: p.PersistentData)
    if pd is not None and safe(lambda: pd.DataCount, 0) > 0:
        vals = []
        for item in safe(lambda: list(pd.AllData(True)), []):
            vals.append(text(item))
            if len(vals) >= 20:
                break
        info["defaults"] = vals
    return info


def assembly_info(proxy):
    server = gh.Instances.ComponentServer
    lib = safe(lambda: server.FindAssemblyByObject(proxy.Guid))
    return {
        "library_name": safe(lambda: lib.Name),
        "library_version": safe(lambda: lib.Version),
        "library_author": safe(lambda: lib.AuthorName),
        "file": safe(lambda: proxy.Location),
    }


def matches(proxy, asm, needle):
    needle = needle.lower()
    hay = [
        safe(lambda: proxy.Desc.Category, ""),
        safe(lambda: proxy.Desc.SubCategory, ""),
        asm.get("library_name") or "",
        asm.get("file") or "",
    ]
    return any(needle in (h or "").lower() for h in hay)


def dump(out_dir, needle):
    server = gh.Instances.ComponentServer
    items = []
    for proxy in server.ObjectProxies:
        asm = assembly_info(proxy)
        if not matches(proxy, asm, needle):
            continue
        entry = {
            "name": safe(lambda: proxy.Desc.Name),
            "nickname": safe(lambda: proxy.Desc.NickName),
            "description": safe(lambda: proxy.Desc.Description),
            "category": safe(lambda: proxy.Desc.Category),
            "subcategory": safe(lambda: proxy.Desc.SubCategory),
            "guid": text(safe(lambda: proxy.Guid)),
            "exposure": text(safe(lambda: proxy.Exposure)),
            "obsolete": safe(lambda: bool(proxy.Obsolete)),
            "kind": text(safe(lambda: proxy.Kind)),
        }
        entry.update(asm)
        obj = safe(lambda: proxy.CreateInstance())
        entry["class"] = safe(lambda: obj.GetType().FullName)
        params = safe(lambda: obj.Params)
        if params is not None and hasattr(params, "Input"):
            entry["object_type"] = "component"
            entry["inputs"] = [param_info(p) for p in params.Input]
            entry["outputs"] = [param_info(p) for p in params.Output]
            entry["variable_parameters"] = safe(
                lambda: hasattr(obj, "CanInsertParameter"), False)
        elif obj is not None and hasattr(obj, "TypeName"):
            entry["object_type"] = "parameter"
            entry["parameter"] = param_info(obj)
        else:
            entry["object_type"] = "other"
        items.append(entry)

    items.sort(key=lambda e: ((e.get("category") or ""), (e.get("subcategory") or ""), (e.get("name") or "")))

    meta = {
        "created": datetime.datetime.now().isoformat(),
        "rhino_version": text(safe(lambda: Rhino.RhinoApp.Version)),
        "grasshopper_version": text(safe(lambda: gh.Versioning.Version)),
        "match": needle,
        "count": len(items),
    }

    if not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    jpath = os.path.join(out_dir, "cs_components.json")
    with open(jpath, "w") as f:
        json.dump({"meta": meta, "components": items}, f, indent=2, default=text)

    lines = ["# ClimateStudio components", "",
             "Created {0}; Rhino {1}; Grasshopper {2}; {3} objects matching '{4}'.".format(
                 meta["created"], meta["rhino_version"], meta["grasshopper_version"], len(items), needle), ""]
    for e in items:
        lines.append("## {0} ({1})".format(e.get("name"), e.get("nickname")))
        lines.append("")
        lines.append("- Category: {0} / {1}".format(e.get("category"), e.get("subcategory")))
        lines.append("- Library: {0} {1}".format(e.get("library_name"), e.get("library_version")))
        lines.append("- Class: `{0}`; GUID `{1}`; {2}".format(e.get("class"), e.get("guid"), e.get("object_type")))
        lines.append("- Description: {0}".format((e.get("description") or "").replace("\n", " ")))
        for side in ("inputs", "outputs"):
            ps = e.get(side)
            if not ps:
                continue
            lines.append("")
            lines.append("**{0}**".format(side.capitalize()))
            lines.append("")
            lines.append("| Name | Nick | Type | Access | Optional | Default | Description |")
            lines.append("| --- | --- | --- | --- | --- | --- | --- |")
            for p in ps:
                lines.append("| {0} | {1} | {2} | {3} | {4} | {5} | {6} |".format(
                    p.get("name"), p.get("nickname"), p.get("type_name"), p.get("access"),
                    p.get("optional"), "; ".join(p.get("defaults") or [])[:80],
                    (p.get("description") or "").replace("\n", " ").replace("|", "/")))
        lines.append("")
    mpath = os.path.join(out_dir, "cs_components.md")
    with open(mpath, "w") as f:
        f.write("\n".join(lines))
    return items, out_dir


path = None
report = "Set run to True to write the component list."
if run:
    needle = match if match else "ClimateStudio"
    out_dir = folder if folder else os.path.join(os.path.expanduser("~"), "Desktop", "cs_dump")
    try:
        items, path = dump(out_dir, needle)
        n_comp = sum(1 for e in items if e.get("object_type") == "component")
        report = "Wrote {0} objects ({1} components) to {2}".format(len(items), n_comp, path)
        if not items:
            report += "\nNothing matched '{0}'. Try match = 'Solemma' or 'CS'.".format(needle)
    except Exception as ex:
        report = "Failed: {0}".format(ex)
