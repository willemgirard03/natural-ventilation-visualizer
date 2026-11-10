// The View tab's views: Create plan (a level, a cut height above it and a name; Create makes the plan
// view, opened only when asked), Create section (a section view from any clipping plane, or a plan view
// from a plan's) and the Views list, each plan or section view renamed, re-cut, opened in the workspace
// or deleted.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (x, d = 2) => String(+Number(x).toFixed(d));
const CUT0 = 1.2; // a plan's cut height above its level, as drawn by convention

// box: the ribbon group; views() -> the named views; levels() -> the levels [{ name, z }] or null;
// changeViews(mutate(host), what); onOpen(id); planes() -> the clipping planes [{ id, kind, name }];
// fromPlane(id) makes a view of a plane's cut, linked to it
export function viewsBar(box, { views, levels, changeViews, onOpen, planes = () => [], fromPlane = () => {} }) {
  const make = { level: 0, cut: CUT0, name: '' };
  const open = { list: false, plan: false, section: false }; // the menus folded out

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
    const pl = planes(), linked = (p) => list.filter((v) => v.plane === p.id).map((v) => esc(v.name)).join(', ');
    let h = '<span class="ribttl">Views</span>';
    // Create plan: a level, a cut above it, a name
    h += `<details class="dd" data-vb="plan"${open.plan ? ' open' : ''}><summary title="A plan view of a level, cut at a height above it. It owns its cut: Cut 3D here, on its bar, adds a clipping plane linked to it.">Create plan</summary><div class="ddmenu vbmake">`;
    h += lv ? `<div class="layrow"><span>Level</span><span><select class="popsel" data-vb="level" title="The level to cut above">${opts(make.level)}</select></span></div>`
      + `<div class="layrow"><span class="tipped" title="Cut height above the level">Cut at</span><span>+ <input class="popnum" data-vb="cut" value="${fmt(make.cut)}" title="Cut height above the level (m)"> m</span></div>`
      + `<div class="layrow"><input class="popname" data-vb="name" value="${esc(make.name)}" placeholder="${esc(suggest())}" title="Its name (Tab takes the suggestion)">`
      + '<button type="button" class="minibtn" data-vb="create" title="Make the plan view: show it from the Views list, or pick it from a plan view\'s name">Create</button></div>'
      : '<div class="layrow muted">A massing\'s levels, or a plan clipping plane under Create section.</div>';
    h += '</div></details>';
    // Create section: a view of any clipping plane's cut
    h += `<details class="dd" data-vb="section"${open.section ? ' open' : ''}><summary title="A view of a clipping plane's cut, linked to it: moving either moves the other">Create section</summary><div class="ddmenu vblist">`;
    if (!pl.length) h += '<div class="layrow muted">No clipping planes yet: add one with Clipping plane.</div>';
    for (const p of pl) {
      const l = linked(p);
      h += `<div class="layrow" data-plane="${p.id}"><span class="vbkind">${p.kind === 'plan' ? 'Plan' : 'Section'}</span><span class="vbpl">${esc(p.name)}</span>`
        + (l ? `<span class="muted" title="Views made from it">${l}</span>` : '')
        + `<button type="button" class="minibtn" data-vb="fromplane" title="A ${p.kind} view of this plane's cut, linked to it">Create ${p.kind} view</button></div>`;
    }
    h += '</div></details>';
    h += `<details class="dd" data-vb="list"${open.list ? ' open' : ''}><summary title="The plan and section views made so far">Views (${list.length})</summary><div class="ddmenu vblist">`;
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
  box.addEventListener('toggle', (e) => {
    const k = e.target.dataset?.vb;
    if (!(k in open)) return;
    open[k] = e.target.open;
    // one menu at a time
    if (e.target.open) for (const d of box.querySelectorAll('details[data-vb]')) if (d !== e.target) d.open = false;
  }, true);
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
      open.plan = false;
      render();
    } else if (b.dataset.vb === 'fromplane') { fromPlane(Number(b.closest('[data-plane]').dataset.plane)); render(); }
    else if (b.dataset.vb === 'open') onOpen(idOf(b));
    else if (b.dataset.vb === 'del') { const id = idOf(b); changeViews((x) => { x.views = x.views.filter((v) => v.id !== id); }, 'view deleted'); render(); }
  });
  return { render };
}
