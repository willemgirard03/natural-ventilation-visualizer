// The View tab's views: Plan at level (a level, a cut height above it and a name; Create makes the
// plan view, opened only when asked) and the Views list, each plan or section view renamed, re-cut,
// opened in the workspace or deleted. Sections are made from a section clipping plane's pop-up.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (x, d = 2) => String(+Number(x).toFixed(d));
const CUT0 = 1.2; // a plan's cut height above its level, as drawn by convention

// box: the ribbon group; views() -> the named views; levels() -> the levels [{ name, z }] or null;
// changeViews(mutate(host), what); onOpen(id)
export function viewsBar(box, { views, levels, changeViews, onOpen }) {
  const make = { level: 0, cut: CUT0, name: '' };
  let open = false; // the Views list folded out

  const suggest = () => {
    const lv = levels(), base = `${lv?.[make.level]?.name || `Level ${make.level + 1}`} plan`, taken = new Set(views().map((v) => v.name));
    let name = base;
    for (let k = 2; taken.has(name); k++) name = `${base} ${k}`;
    return name;
  };
  const opts = (now) => (levels() || []).map((l, L) => `<option value="${L}"${L === now ? ' selected' : ''}>${esc(l.name)}</option>`).join('');

  function render() {
    if (box.contains(document.activeElement) && document.activeElement.matches('input, select')) return;
    const lv = levels(), list = views();
    make.level = Math.min(make.level, Math.max(0, (lv?.length || 1) - 1));
    let h = '<span class="ribttl tipped" title="A plan view of a level, cut at a height above it. It owns its cut: Cut 3D here, on its bar, adds a clipping plane linked to it.">Plan at level</span>';
    h += lv ? `<select class="popsel" data-vb="level" title="The level to cut above">${opts(make.level)}</select> + <input class="popnum" data-vb="cut" value="${fmt(make.cut)}" title="Cut height above the level (m)"> m`
      + `<input class="popname" data-vb="name" value="${esc(make.name)}" placeholder="${esc(suggest())}" title="Its name (Tab takes the suggestion)">`
      + '<button type="button" class="minibtn" data-vb="create" title="Make the plan view: show it from the Views list, or pick it from a plan view\'s name">Create</button>'
      : '<span class="muted">a massing\'s levels</span>';
    h += `<details class="dd" data-vb="list"${open ? ' open' : ''}><summary title="The plan and section views made so far">Views (${list.length})</summary><div class="ddmenu vblist">`;
    if (!list.length) h += '<div class="layrow muted">None yet.</div>';
    for (const v of list) {
      h += `<div class="layrow" data-view="${v.id}"><span class="vbkind">${v.kind === 'plan' ? 'Plan' : 'Section'}</span><input class="libname" data-vb="vname" value="${esc(v.name)}" title="Its name">`;
      if (v.kind === 'plan' && Number.isInteger(v.level) && lv) h += `<select class="popsel" data-vb="vlevel" title="The level it is cut above">${opts(v.level)}</select> + <input class="popnum" data-vb="vcut" value="${fmt(v.cut)}" title="Cut height above the level (m)"> m`;
      else h += `<span class="muted">${v.plane !== undefined && v.plane !== null ? 'from a clipping plane' : 'its own cut'}</span>`;
      h += '<button type="button" class="minibtn" data-vb="open" title="Show it in a view">Open</button><button type="button" class="pbtn x" data-vb="del" title="Delete this view">×</button></div>';
    }
    box.innerHTML = h + '</div></details>';
  }

  const idOf = (el) => Number(el.closest('[data-view]').dataset.view);
  const find = (x, id) => x.views.find((v) => v.id === id);
  box.addEventListener('toggle', (e) => { if (e.target.dataset?.vb === 'list') open = e.target.open; }, true);
  box.addEventListener('change', (e) => {
    const t = e.target, k = t.dataset.vb, num = Number(String(t.value).replace(',', '.'));
    if (k === 'level') { make.level = Number(t.value); render(); }
    else if (k === 'cut') { if (Number.isFinite(num)) make.cut = num; }
    else if (k === 'name') make.name = t.value;
    else if (k === 'vname') { const id = idOf(t), v = t.value.trim(); if (v) changeViews((x) => { find(x, id).name = v; }, 'view renamed'); render(); }
    else if (k === 'vlevel') { const id = idOf(t); changeViews((x) => { find(x, id).level = Number(t.value); }, 'plan level set'); }
    else if (k === 'vcut') { const id = idOf(t); if (Number.isFinite(num)) changeViews((x) => { find(x, id).cut = num; }, 'plan cut height set'); render(); }
  });
  box.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.key === 'Tab' && t.dataset.vb === 'name' && !t.value) { t.value = t.placeholder; make.name = t.value; }
    if (e.key === 'Enter') { if (t.dataset.vb === 'name') { make.name = t.value; box.querySelector('[data-vb=create]').click(); } else t.blur(); }
    e.stopPropagation();
  });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-vb]');
    if (!b) return;
    if (b.dataset.vb === 'create') {
      const name = make.name.trim() || suggest(), L = make.level, cut = make.cut;
      changeViews((x) => { x.views ||= []; x.views.push({ id: Math.max(0, ...x.views.map((v) => v.id + 1)), kind: 'plan', name, level: L, cut }); }, `plan view ${name} created`);
      make.name = '';
      render();
    } else if (b.dataset.vb === 'open') onOpen(idOf(b));
    else if (b.dataset.vb === 'del') { const id = idOf(b); changeViews((x) => { x.views = x.views.filter((v) => v.id !== id); }, 'view deleted'); render(); }
  });
  return { render };
}
