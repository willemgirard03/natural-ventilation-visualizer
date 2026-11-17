// A command line, as Rhino's: type a command's first letters (any case) and it is filled in, the rest
// shown faintly; a list of the matches drops under it. Tab or → takes the filled-in name, ↑ ↓ step
// through the list, Enter runs it (Enter on an empty line runs the last command again), Esc clears it.
// Typing a letter anywhere else (not in a box, no tool taking the keys) starts a command; Enter with
// nothing going on, or a right click on a drawing, runs the last one again.
//
// commandLine(el, commands, { taken }): el is a .cmdline holding an input; commands [{ name, run,
// title?, also?: [other names] }]; taken(e) says whether a key belongs to something else (a tool's
// typed length); idle() whether no command is going on; area(target) whether a right click there is
// Enter (a drawing).

const norm = (s) => s.toLowerCase().replace(/[\s/_-]+/g, '');

export function commandLine(el, commands, { taken = () => false, idle = () => true, area = () => false } = {}) {
  const input = el.querySelector('input'), ghost = document.createElement('span'), list = document.createElement('div');
  ghost.className = 'cmdghost'; list.className = 'cmdlist'; list.hidden = true;
  el.append(ghost, list);
  let matches = [], at = 0, last = null;
  // the commands whose name (or another name), or any word of it, starts with what is typed; whole
  // names first, then words, each in the list's order
  const find = (t) => {
    const q = norm(t);
    if (!q) return [];
    const starts = (c) => [c.name, ...(c.also || [])].some((n) => norm(n).startsWith(q));
    const word = (c) => [c.name, ...(c.also || [])].some((n) => n.toLowerCase().split(/\s+/).some((w) => norm(w).startsWith(q)));
    return [...commands.filter(starts), ...commands.filter((c) => !starts(c) && word(c))];
  };
  const show = () => {
    matches = find(input.value);
    at = Math.min(at, Math.max(0, matches.length - 1));
    const c = matches[at], typed = input.value;
    // the rest of the name, faintly, when it begins with what is typed
    ghost.textContent = c && norm(c.name).startsWith(norm(typed)) && c.name.toLowerCase().startsWith(typed.toLowerCase()) ? typed + c.name.slice(typed.length) : '';
    list.innerHTML = matches.slice(0, 9).map((m, i) => `<button type="button" data-i="${i}" class="${i === at ? 'on' : ''}" title="${(m.title || '').replace(/"/g, '&quot;')}">${m.name}</button>`).join('');
    list.hidden = !matches.length || !typed;
  };
  const run = (c) => {
    input.value = ''; show(); input.blur();
    if (!c) return;
    last = c;
    c.run();
  };
  input.addEventListener('input', () => { at = 0; show(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { input.value = ''; show(); input.blur(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (matches.length) at = (at + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length; show(); return; }
    if ((e.key === 'Tab' || (e.key === 'ArrowRight' && input.selectionStart === input.value.length)) && matches[at]) { e.preventDefault(); input.value = matches[at].name; show(); return; }
    if (e.key === 'Enter') { e.preventDefault(); run(input.value.trim() ? matches[at] : last); }
  });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; ghost.textContent = ''; }, 150));
  input.addEventListener('focus', show);
  list.addEventListener('pointerdown', (e) => { const b = e.target.closest('[data-i]'); if (b) { e.preventDefault(); run(matches[Number(b.dataset.i)]); } });
  // a letter typed with nothing else taking it starts a command
  addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || !/[a-z]/i.test(e.key)) return;
    if (e.target.closest?.('input, select, textarea, [contenteditable]') || taken(e)) return;
    e.preventDefault();
    input.focus();
    input.value = e.key;
    at = 0;
    show();
  });
  // Enter with no box or button taking it and no command going on: the last command again
  addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.('input, select, textarea, button, a, [contenteditable]') || !idle() || !last) return;
    e.preventDefault();
    run(last);
  });
  // A right click (not a drag) on a drawing is Enter, as in Rhino: a command typed runs; a command going
  // on is finished (what Enter does in it); with none, the last command runs again.
  let rdown = null;
  addEventListener('pointerdown', (e) => { rdown = e.button === 2 && area(e.target) ? [e.clientX, e.clientY] : null; }, true);
  addEventListener('pointerup', (e) => {
    if (e.button !== 2 || !rdown) return;
    const moved = Math.hypot(e.clientX - rdown[0], e.clientY - rdown[1]) > 4;
    rdown = null;
    if (moved) return;
    if (input.value.trim()) { run(find(input.value)[at] || find(input.value)[0]); return; }
    if (!idle()) { dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return; }
    if (last) run(last);
  }, true);
  // remember(name): a command begun some other way (its button) is the last one, for Enter to repeat
  return { input, run: (name) => run(commands.find((c) => c.name === name)), remember: (name) => { last = commands.find((c) => c.name === name) || last; } };
}
