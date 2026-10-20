"""
ClimateStudio object probe (desktop session 1, step 2b)

Shows what kind of data a ClimateStudio component outputs, by reflecting on
the .NET objects that arrive. Use it on Deconstruct CS Energy Model's outputs
(and on CS Window, CS Energy Zone, Get CS Space Use Template, etc.).

Paste into a Grasshopper Python component (Rhino 8 "Python 3 Script" or
Rhino 7 "GhPython").

Inputs:
    Add as many inputs as you like (zoom in on the component, click +).
    Give each any name, set its access to "Tree Access", no type hint.
    Wire one ClimateStudio output into each.
    Also add:
        save    bool   True to write the report to a file (optional)
        folder  str    output folder (optional; default: Desktop\\cs_dump)

Outputs:
    report  str    readable description of every input

Writes (when save is True):
    cs_probe_<timestamp>.txt
"""

import os
import datetime

DEPTH = 3          # how far to follow nested objects
MAX_ITEMS = 5      # items shown per list or branch
MAX_TEXT = 300     # characters per value

try:
    save
except NameError:
    save = False
try:
    folder
except NameError:
    folder = None

SKIP_INPUTS = ("save", "folder")


def short(v):
    try:
        s = str(v)
    except Exception:
        s = repr(v)
    s = s.replace("\r", " ").replace("\n", " ")
    return s if len(s) <= MAX_TEXT else s[:MAX_TEXT] + "..."


def net_type(v):
    try:
        return v.GetType().FullName
    except Exception:
        return type(v).__name__


SIMPLE = ("System.String", "System.Double", "System.Int32", "System.Int64", "System.Boolean",
          "System.Single", "System.Guid", "System.DateTime", "System.Decimal")


def is_simple(v):
    if v is None or isinstance(v, (str, int, float, bool)):
        return True
    return net_type(v) in SIMPLE or net_type(v).startswith("System.Enum")


def as_list(v):
    """Return a Python list if v is an enumerable collection (not a string), else None."""
    if isinstance(v, (str, bytes)):
        return None
    if net_type(v) == "System.String":
        return None
    try:
        import System.Collections as SC
        if isinstance(v, SC.IEnumerable):
            out = []
            for i, item in enumerate(v):
                out.append(item)
                if i > 200:
                    break
            return out
    except Exception:
        pass
    if isinstance(v, (list, tuple)):
        return list(v)
    return None


def describe(v, depth, indent, lines, seen):
    pad = "  " * indent
    if is_simple(v):
        lines.append("{0}= {1}  [{2}]".format(pad, short(v), net_type(v)))
        return
    key = id(v)
    if key in seen:
        lines.append("{0}(already shown) [{1}]".format(pad, net_type(v)))
        return
    seen.add(key)
    lst = as_list(v)
    if lst is not None:
        lines.append("{0}collection of {1} [{2}]".format(pad, len(lst), net_type(v)))
        if depth > 0:
            for i, item in enumerate(lst[:MAX_ITEMS]):
                lines.append("{0}  [{1}]".format(pad, i))
                describe(item, depth - 1, indent + 2, lines, seen)
        return
    lines.append("{0}object [{1}]  str: {2}".format(pad, net_type(v), short(v)))
    if depth <= 0:
        return
    try:
        import System.Reflection as R
        flags = R.BindingFlags.Public | R.BindingFlags.Instance
        props = v.GetType().GetProperties(flags)
    except Exception:
        props = []
    for p in props:
        try:
            if p.GetIndexParameters().Length > 0:
                continue
            val = p.GetValue(v, None)
        except Exception as ex:
            lines.append("{0}  .{1}: <error {2}>".format(pad, p.Name, short(ex)))
            continue
        if is_simple(val):
            lines.append("{0}  .{1} = {2}  [{3}]".format(pad, p.Name, short(val), net_type(val)))
        else:
            lines.append("{0}  .{1}:".format(pad, p.Name))
            describe(val, depth - 1, indent + 2, lines, seen)


def branches(value):
    """Yield (path, items) for a DataTree, or one pseudo-branch for anything else."""
    if hasattr(value, "Paths") and hasattr(value, "Branch"):
        for i, path in enumerate(value.Paths):
            yield str(path), list(value.Branch(path))
    else:
        lst = as_list(value)
        yield "{0}", (lst if lst is not None else [value])


lines = ["ClimateStudio object probe, {0}".format(datetime.datetime.now().isoformat()), ""]
comp = ghenv.Component  # noqa: F821  (provided by Grasshopper)
for p in comp.Params.Input:
    name = p.NickName
    if name in SKIP_INPUTS:
        continue
    src_names = []
    for s in p.Sources:
        try:
            owner = s.Attributes.GetTopLevel.DocObject.NickName
            src_names.append("{0} ({1})".format(s.NickName, owner))
        except Exception:
            src_names.append(str(s.NickName))
    sources = ", ".join(src_names) or "nothing connected"
    lines.append("=" * 70)
    lines.append("Input '{0}' <- {1}".format(name, sources))
    value = globals().get(name)
    if value is None:
        lines.append("  (no data)")
        continue
    for path, items in branches(value):
        lines.append("  branch {0}: {1} item(s)".format(path, len(items)))
        for i, item in enumerate(items[:MAX_ITEMS]):
            lines.append("  item {0}:".format(i))
            describe(item, DEPTH, 2, lines, set())
        if len(items) > MAX_ITEMS:
            lines.append("  ... {0} more".format(len(items) - MAX_ITEMS))
    lines.append("")

report = "\n".join(lines)

if save:
    out_dir = folder if folder else os.path.join(os.path.expanduser("~"), "Desktop", "cs_dump")
    if not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    fname = "cs_probe_{0}.txt".format(datetime.datetime.now().strftime("%Y%m%d_%H%M%S"))
    with open(os.path.join(out_dir, fname), "w") as f:
        f.write(report)
    report = "Saved {0}\n\n{1}".format(os.path.join(out_dir, fname), report)
