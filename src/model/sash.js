// Window sashes: how a window opens, and how far it must open to give its operable fraction.
// ClimateStudio and EnergyPlus treat a window as a plane opened over a fraction of its area. The tool
// interprets that plane as the rough opening of a hinged sash (PLAN.md, Data model: window
// interpretation): it finds the angle at which the sash leaves that fraction free, and says so when
// the sash's mechanism cannot open that far.
//
// Free area (geometric): the smaller of the rough opening and the gaps around the open sash: along its
// free edge, a gap as long as that edge and as wide as the chord the edge moves through
// (2 L sin(angle / 2)), plus a triangle at each side (1/2 L^2 sin(angle)), L being the sash's length
// from hinge to free edge. A top-hung (awning) sash on a tall window opens most of its area through
// those side triangles, which is why it is the stress test.

export const SASH_TYPES = {
  casement: { label: 'Casement', hinge: 'side', opens: 'out', maxAngle: 90, help: 'hinged at one side, opening outwards' },
  awning: { label: 'Awning', hinge: 'top', opens: 'out', maxAngle: 45, help: 'hinged at the top, opening outwards at the bottom' },
  hopper: { label: 'Hopper', hinge: 'bottom', opens: 'in', maxAngle: 35, help: 'hinged at the bottom, opening inwards at the top' },
};

// Fraction of the rough opening (width W, height H, m) left free at an opening angle (degrees).
export function freeFraction(type, W, H, angle) {
  const t = SASH_TYPES[type];
  if (!t || angle <= 0) return 0;
  const a = (Math.min(angle, 180) * Math.PI) / 180;
  const [edge, length] = t.hinge === 'side' ? [H, W] : [W, H]; // free edge, and hinge-to-free-edge
  const gaps = edge * 2 * length * Math.sin(a / 2) + length * length * Math.sin(a);
  return Math.min(1, gaps / (W * H));
}

// The angle (degrees) at which a sash leaves `fraction` of the opening free, within its mechanism's
// limit. { angle, fraction (what it gives), reachable, maxFraction (at the limit) }.
export function sashAngle(type, W, H, fraction, maxAngle = SASH_TYPES[type]?.maxAngle ?? 90) {
  const maxFraction = freeFraction(type, W, H, maxAngle);
  if (fraction <= 0) return { angle: 0, fraction: 0, reachable: true, maxFraction };
  if (fraction >= maxFraction) return { angle: maxAngle, fraction: maxFraction, reachable: fraction <= maxFraction + 1e-9, maxFraction };
  let lo = 0, hi = maxAngle; // free fraction grows with the angle up to 90 degrees
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (freeFraction(type, W, H, mid) < fraction) lo = mid; else hi = mid;
  }
  return { angle: hi, fraction, reachable: true, maxFraction };
}
