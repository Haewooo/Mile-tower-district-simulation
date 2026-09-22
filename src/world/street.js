/**
 * Street furniture: the things that make a road read as a road.
 *
 * The plan already had lane markings and a glowing point per lamp. What it did
 * not have was anything with a shadow — no poles, no signal heads, no painted
 * crossings — so at street level the city was a set of surfaces rather than a
 * place.
 *
 * Everything here is instanced through the existing chunk system and tagged
 * `detail`, which means it only draws inside the 260-unit LOD band. The point
 * cloud stays exactly as it was and becomes the far LOD: past that distance a
 * lamp is a dot of light, which is all a lamp is from a kilometre up.
 *
 * Scale throughout: 1 world unit = 10 m.
 */
import * as THREE from '../../vendor/three.bundle.min.js';
import { mergeGeos, flatRing, radialStrip, sectorGeo } from '../core/geometry.js';
import { TAU, ZB, EDGE, MARK_Y } from '../core/config.js';
import { polar, riverD } from '../core/math.js';

const U = 0.1;   // one metre

/* ---------------------------------------------------------------- geometry */

/**
 * A street lamp: tapered pole, curved arm, and a downturned head.
 * Origin at the base, arm reaching along +X.
 */
export function lampGeometry() {
  const H = 9 * U, ARM = 1.6 * U;
  const parts = [];

  parts.push(new THREE.CylinderGeometry(0.11 * U, 0.16 * U, H, 6).translate(0, H / 2, 0));
  // base collar — reads as a footing at close range
  parts.push(new THREE.CylinderGeometry(0.22 * U, 0.26 * U, 0.35 * U, 6).translate(0, 0.17 * U, 0));

  // arm, approximated as three short segments rather than a swept curve
  const seg = 4;
  for (let i = 0; i < seg; i++) {
    const t0 = i / seg, t1 = (i + 1) / seg;
    const x0 = ARM * t0, x1 = ARM * t1;
    const y0 = H - 0.35 * U * t0 * t0, y1 = H - 0.35 * U * t1 * t1;
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
    const g = new THREE.CylinderGeometry(0.08 * U, 0.09 * U, len, 5);
    g.rotateZ(-Math.atan2(dx, dy));
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
    parts.push(g);
  }

  // luminaire housing
  const head = new THREE.BoxGeometry(0.85 * U, 0.16 * U, 0.34 * U);
  head.translate(ARM + 0.3 * U, H - 0.42 * U, 0);
  parts.push(head);

  return mergeGeos(parts);
}

/** The lens underside, a separate mesh so it can glow on its own at night. */
export function lampLensGeometry() {
  const H = 9 * U, ARM = 1.6 * U;
  const g = new THREE.BoxGeometry(0.72 * U, 0.04 * U, 0.26 * U);
  g.translate(ARM + 0.3 * U, H - 0.52 * U, 0);
  return g;
}

/**
 * A signal on a mast arm: upright, horizontal arm, and one three-lamp head
 * hanging at the end. Origin at the base, arm along +X.
 */
export function signalGeometry() {
  const H = 6.5 * U, ARM = 5 * U;
  const parts = [];

  parts.push(new THREE.CylinderGeometry(0.13 * U, 0.18 * U, H, 6).translate(0, H / 2, 0));
  parts.push(new THREE.CylinderGeometry(0.28 * U, 0.32 * U, 0.4 * U, 6).translate(0, 0.2 * U, 0));

  const arm = new THREE.CylinderGeometry(0.1 * U, 0.11 * U, ARM, 5);
  arm.rotateZ(Math.PI / 2);
  arm.translate(ARM / 2, H - 0.25 * U, 0);
  parts.push(arm);

  // housing: a tall box with a visor over each lamp
  const box = new THREE.BoxGeometry(0.42 * U, 1.25 * U, 0.36 * U);
  box.translate(ARM, H - 1.15 * U, 0);
  parts.push(box);
  for (let i = 0; i < 3; i++) {
    const visor = new THREE.CylinderGeometry(0.2 * U, 0.2 * U, 0.22 * U, 8, 1, true, 0, Math.PI);
    visor.rotateX(Math.PI / 2);
    visor.rotateZ(Math.PI);
    visor.translate(ARM, H - 0.75 * U - i * 0.36 * U, 0.2 * U);
    parts.push(visor);
  }
  return mergeGeos(parts);
}

/** The three lenses, one geometry each so they can be lit independently. */
export function signalLensGeometry(index) {
  const H = 6.5 * U, ARM = 5 * U;
  const g = new THREE.CylinderGeometry(0.15 * U, 0.15 * U, 0.05 * U, 10);
  g.rotateX(Math.PI / 2);
  g.translate(ARM, H - 0.75 * U - index * 0.36 * U, 0.19 * U);
  return g;
}

/** A bollard: the cheapest thing that says "cars stop here". */
export function bollardGeometry() {
  return mergeGeos([
    new THREE.CylinderGeometry(0.09 * U, 0.11 * U, 0.9 * U, 6).translate(0, 0.45 * U, 0),
    new THREE.SphereGeometry(0.09 * U, 6, 4).translate(0, 0.9 * U, 0),
  ]);
}

/** A bench: slab seat on two legs, facing +Z. */
export function benchGeometry() {
  return mergeGeos([
    new THREE.BoxGeometry(1.8 * U, 0.08 * U, 0.5 * U).translate(0, 0.45 * U, 0),
    new THREE.BoxGeometry(1.8 * U, 0.45 * U, 0.08 * U).translate(0, 0.66 * U, -0.2 * U),
    new THREE.BoxGeometry(0.1 * U, 0.45 * U, 0.44 * U).translate(-0.75 * U, 0.22 * U, 0),
    new THREE.BoxGeometry(0.1 * U, 0.45 * U, 0.44 * U).translate(0.75 * U, 0.22 * U, 0),
  ]);
}

/* --------------------------------------------------------------- junctions */

/**
 * Every place a boulevard crosses a main ring.
 *
 * Signals and cars both read this, which is the point: a light that says stop
 * and a car that does not is worse than no light at all. `phase` alternates by
 * ring so the whole city does not switch at once — a crude green wave, and
 * enough to stop the junctions looking synchronised from above.
 *
 * Ring traffic runs on `phase`, boulevard traffic on the opposite one.
 */
export function planJunctions({ rings }) {
  const out = [];
  const mains = rings.filter(g => g.main);
  mains.forEach((g, ringIdx) => {
    for (let k = 0; k < 3; k++) {
      const a = k * TAU / 3;
      const [x, z] = polar(g.r, a);
      if (offEdge(x, z) || inRiver(x, z)) continue;
      out.push({
        ringIdx, k, a,
        r: g.r,
        halfRing: g.w / 2,      // half-width of the ring carriageway
        halfBlvd: 4,            // half-width of the boulevard carriageway
        phase: ringIdx % 2,
      });
    }
  });
  return out;
}

/* --------------------------------------------------------------- placement */

const offEdge = (x, z) => Math.hypot(x, z) > EDGE + 2;
const inRiver = (x, z) => riverD(x, z) < 18 + 1;   // RIVER.half + 1

/**
 * Where the lamps, signals and bollards go.
 *
 * Lamps repeat along every ring and boulevard at a spacing wide enough to keep
 * the instance count in five figures rather than six; the point cloud is
 * denser because a point costs almost nothing and a pole does not.
 */
export function planStreetFurniture({ rings, spokes }) {
  const lamps = [];   // {x, z, th}
  const signals = []; // {x, z, th}
  const bollards = [];

  const addLamp = (x, z, th) => { if (!offEdge(x, z) && !inRiver(x, z)) lamps.push({ x, z, th }); };

  // Along the ring roads, on both kerbs, arm pointing at the carriageway.
  rings.forEach(g => {
    if (!g.main) return;                       // side streets keep the point cloud only
    const step = 3.2;                          // 32 m
    [-1, 1].forEach(s => {
      const r = g.r + s * (g.w / 2 + 0.35);
      const n = Math.max(8, Math.round(TAU * r / step));
      for (let i = 0; i < n; i++) {
        const a = i / n * TAU;
        const [x, z] = polar(r, a);
        // +X of the lamp should point inward/outward toward the road
        addLamp(x, z, a + (s > 0 ? Math.PI : 0));
      }
    });
  });

  // The three boulevards, lamps in the median looking both ways.
  for (let k = 0; k < 3; k++) {
    const a = k * TAU / 3;
    const tx = Math.cos(a), tz = -Math.sin(a);
    for (let r = 32; r < EDGE; r += 3.6) {
      const [x, z] = polar(r, a);
      [-1, 1].forEach(s => addLamp(x + tx * s * 4.6, z + tz * s * 4.6, a + (s > 0 ? Math.PI : 0)));
    }
  }

  // Signals at each junction. Two heads govern the ring approaches and two the
  // boulevard approaches, each showing the phase its own traffic obeys.
  planJunctions({ rings }).forEach(j => {
    const tx = Math.cos(j.a), tz = -Math.sin(j.a);
    const [cx, cz] = polar(j.r, j.a);

    // Ring approaches: heads set back along the ring, arms over the ring lanes.
    [-1, 1].forEach(side => {
      const x = cx + tx * side * (j.halfBlvd + 0.9), z = cz + tz * side * (j.halfBlvd + 0.9);
      if (offEdge(x, z) || inRiver(x, z)) return;
      signals.push({ x, z, th: j.a + (side > 0 ? Math.PI : 0), phase: j.phase, governs: 'ring' });
    });

    // Boulevard approaches: heads set back along the boulevard.
    [-1, 1].forEach(along => {
      const r = j.r + along * (j.halfRing + 0.9);
      const [x, z] = polar(r, j.a);
      if (offEdge(x, z) || inRiver(x, z)) return;
      signals.push({ x, z, th: j.a + Math.PI / 2 + (along > 0 ? Math.PI : 0),
                     phase: j.phase ^ 1, governs: 'blvd' });
    });
  });

  // Bollards separating the boulevard footway from the carriageway, near the
  // centre where there is most foot traffic.
  for (let k = 0; k < 3; k++) {
    const a = k * TAU / 3;
    const tx = Math.cos(a), tz = -Math.sin(a);
    for (let r = 32; r < 150; r += 0.45) {
      const [x, z] = polar(r, a);
      [-1, 1].forEach(s => {
        const bx = x + tx * s * 4.0, bz = z + tz * s * 4.0;
        if (!offEdge(bx, bz) && !inRiver(bx, bz)) bollards.push({ x: bx, z: bz, th: a });
      });
    }
  }

  // Benches on the boulevard footway, facing the carriageway, spaced far
  // enough apart to read as street furniture rather than a waiting room.
  const benches = [];
  for (let k = 0; k < 3; k++) {
    const a = k * TAU / 3;
    const tx = Math.cos(a), tz = -Math.sin(a);
    for (let r = 36; r < 210; r += 7.5) {
      const [x, z] = polar(r, a);
      [-1, 1].forEach(s => {
        const bx = x + tx * s * 4.65, bz = z + tz * s * 4.65;
        if (!offEdge(bx, bz) && !inRiver(bx, bz)) benches.push({ x: bx, z: bz, th: a + (s > 0 ? 0 : Math.PI) });
      });
    }
  }

  return { lamps, signals, bollards, benches };
}

/**
 * Zebra crossings and stop lines at every boulevard/main-ring junction.
 *
 * Dimensions are metres via `U`, which the first version of this function got
 * wrong: it used bare world units, so a 0.5 m stripe came out 5 m wide and the
 * crossings landed on the footway instead of the carriageway.
 *
 * Geometry of a junction: the box spans the ring's width radially and the
 * boulevard's width tangentially. A crossing sits just outside that box on
 * each of the four arms, and its stripes run *parallel to the traffic they
 * cross* — radial stripes where cars drive radially, arcs where they drive
 * around. Stop lines sit a car's length further back again, and only across
 * the half of the road that is actually approaching.
 */
export function crossingGeometry({ rings }) {
  const stripes = [];

  const STRIPE_W = 0.5 * U;
  const PITCH = 1.0 * U;       // painted bar plus an equal gap
  const DEPTH = 3.5 * U;       // how far the crossing reaches along the road
  const LINE = 0.4 * U;
  const GAP = 1.0 * U;         // breathing room past the kerb

  // The footways run straight through these junctions rather than stopping at
  // them, and they are a kerb height above the carriageway — so a crossing
  // painted at the edge of the junction box disappears underneath one. Both
  // crossings start outside the footway that would otherwise cover them.
  const RING_WALK = 0.55;      // ring footway width, outside the carriageway
  const BLVD_WALK_OUT = 4.6;   // outer edge of the boulevard footway

  rings.filter(g => g.main).forEach(g => {
    const hr = g.w / 2;        // half the ring carriageway
    const hb = 4;              // half the boulevard carriageway (80 m wide)

    for (let k = 0; k < 3; k++) {
      const a = k * TAU / 3;
      const [jx, jz] = polar(g.r, a);
      if (offEdge(jx, jz) || inRiver(jx, jz)) continue;

      // --- across the boulevard: radial stripes, clear of the ring footway ---
      const rOff = hr + RING_WALK + GAP + DEPTH / 2;
      [-1, 1].forEach(along => {
        const rc = g.r + along * rOff;
        for (let off = -hb + PITCH / 2; off < hb; off += PITCH) {
          stripes.push(radialStrip(a, rc - DEPTH / 2, rc + DEPTH / 2, STRIPE_W, off));
        }
      });

      // --- across the ring: arc stripes, clear of the boulevard footway ---
      const angOff = (BLVD_WALK_OUT + GAP + DEPTH / 2) / g.r;
      [-1, 1].forEach(side => {
        const ang = a + side * angOff;
        const half = (DEPTH / 2) / g.r;
        for (let rr = g.r - hr + PITCH / 2; rr < g.r + hr; rr += PITCH) {
          stripes.push(sectorGeo(rr - STRIPE_W / 2, rr + STRIPE_W / 2, ang - half, ang + half));
        }
      });

      // --- stop lines, one car length behind each crossing ---
      // Lanes at off > 0 run outward, so traffic arriving from outside is the
      // one on the negative side, and vice versa.
      const rStop = rOff + DEPTH / 2 + 1 * U;
      stripes.push(radialStrip(a, g.r + rStop - LINE / 2, g.r + rStop + LINE / 2, hb, -hb / 2));
      stripes.push(radialStrip(a, g.r - rStop - LINE / 2, g.r - rStop + LINE / 2, hb, hb / 2));

      // Ring lanes at larger radius run with increasing angle, so they arrive
      // from the low-angle side.
      {
        const angStop = angOff + (DEPTH / 2 + 1 * U) / g.r;
        const dAng = LINE / g.r;
        const angA = a - angStop, angB = a + angStop;
        stripes.push(sectorGeo(g.r, g.r + hr, angA - dAng / 2, angA + dAng / 2));
        stripes.push(sectorGeo(g.r - hr, g.r, angB - dAng / 2, angB + dAng / 2));
      }
    }
  });

  return stripes.length ? mergeGeos(stripes) : null;
}

/** Ring-road stop bars where side streets meet, kept separate so it can be skipped. */
export function junctionMarks({ rings }) {
  const out = [];
  rings.filter(g => !g.main && g.r > ZB[1]).forEach(g => {
    out.push(flatRing(g.r - g.w / 2 - 0.07, g.r - g.w / 2 - 0.01));
  });
  return out.length ? mergeGeos(out) : null;
}

export const STREET_Y = MARK_Y + 0.001;   // crossings sit just over the lane lines
