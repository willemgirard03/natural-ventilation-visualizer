// Turns a network solution into the streams air follows, for drawing. A stream is one direction of
// flow through one link: from a zone or outdoors (-1) to a zone or outdoors, at a mass flow rate,
// through a band of the opening's height (fractions 0 = bottom, 1 = top).
//
// In an opening with two-way flow, the colder (denser) side's air runs along the bottom. The band
// boundary is the neutral plane: as the solver found it (solution.links[i].neutral), or else placed so
// each band's share follows a rectangle's flow law F ~ h^(3/2).
// Cracks have no position on their surface in the network, so their streams cover the whole surface.

export function flowStreams(net, solution, conditions) {
  const temp = (zoneIndex) => (zoneIndex < 0 ? conditions.outdoor.t : conditions.zones[net.zones[zoneIndex]].t);
  const streams = [];
  solution.links.forEach((r, i) => {
    const l = net.links[i];
    const ends = [[l.n, l.m, r.forward], [l.m, l.n, r.backward]].filter(([, , rate]) => rate > 1e-9);
    if (l.type !== 'opening' || ends.length < 2) {
      for (const [from, to, rate] of ends) streams.push({ link: i, from, to, rate, band: [0, 1] });
      return;
    }
    // Two-way: the stream leaving the colder side is the bottom one.
    const [a, b] = ends;
    const [bottom, top] = temp(a[0]) <= temp(b[0]) ? [a, b] : [b, a];
    const wb = bottom[2] ** (2 / 3), wt = top[2] ** (2 / 3);
    const split = r.neutral > 0 && r.neutral < 1 ? r.neutral : wb / (wb + wt);
    streams.push({ link: i, from: bottom[0], to: bottom[1], rate: bottom[2], band: [0, split] });
    streams.push({ link: i, from: top[0], to: top[1], rate: top[2], band: [split, 1] });
  });
  const outlets = net.zones.map(() => []), inlets = net.zones.map(() => []);
  for (const s of streams) {
    if (s.from >= 0) outlets[s.from].push(s);
    if (s.to >= 0) inlets[s.to].push(s);
  }
  const entries = streams.filter((s) => s.from < 0);
  const throughflow = net.zones.map((_, z) => inlets[z].reduce((t, s) => t + s.rate, 0));
  return { streams, entries, outlets, inlets, throughflow, outdoorIn: entries.reduce((t, s) => t + s.rate, 0) };
}
