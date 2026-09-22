/**
 * Geometry helpers for the ground plane: merged static meshes, and the sector,
 * strip and ring shapes the radial plan is drawn with.
 */
import * as THREE from '../../vendor/three.bundle.min.js';

/**
 * Flatten many geometries into one buffer. Everything merged here is static
 * ground, so it is cheaper as a single draw call than as hundreds.
 *
 * `uvScale` projects UVs from world XZ, which is what lets one tiling texture
 * run across the whole merged surface without per-piece UV work.
 */
export function mergeGeos(list, uvScale) {
  let n = 0;
  const parts = list.map(g => {
    const q = g.index ? g.toNonIndexed() : g;
    n += q.attributes.position.count;
    return q;
  });

  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  parts.forEach(q => {
    pos.set(q.attributes.position.array, o * 3);
    nor.set(q.attributes.normal.array, o * 3);
    o += q.attributes.position.count;
  });

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));

  if (uvScale) {
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { uv[i * 2] = pos[i * 3] * uvScale; uv[i * 2 + 1] = pos[i * 3 + 2] * uvScale; }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  return g;
}

/** An annular sector lying flat, segmented finely enough to stay smooth at its radius. */
export function sectorGeo(r0, r1, a0, a1) {
  const g = new THREE.RingGeometry(r0, r1, Math.max(6, Math.round((a1 - a0) * r1 / 3)), 1, a0 - Math.PI / 2, a1 - a0);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** A radial road: a flat strip running outward along angle `a`. */
export function radialStrip(a, r0, r1, w, off) {
  const g = new THREE.PlaneGeometry(w, r1 - r0);
  g.rotateX(-Math.PI / 2);
  g.translate(off || 0, 0, (r0 + r1) / 2);
  g.rotateY(a);
  return g;
}

/** A full flat ring — the ring roads. */
export function flatRing(r0, r1) {
  const g = new THREE.RingGeometry(r0, r1, Math.max(96, Math.round(r1 * 1.6)));
  g.rotateX(-Math.PI / 2);
  return g;
}


/**
 * A ring, broken wherever another road crosses it.
 *
 * Footways and edge lines were drawn as complete circles and unbroken radial
 * strips, so at every junction the two crossed in the middle of the
 * carriageway and left a raised kerb-height hash of pavement across it. Real
 * ones stop at the kerb.
 *
 * @param {Array<[number,number]>} gaps plan-angle ranges to leave out
 */
export function ringArcs(r0, r1, gaps) {
  const TAU = Math.PI * 2;
  const norm = a => ((a % TAU) + TAU) % TAU;

  // Overlapping gaps have to be merged first. Left as they are, the arc
  // between two overlapping spans comes out reversed and the ring is drawn
  // twice over the same stretch.
  const raw = gaps
    .map(([a0, a1]) => [norm(a0), norm(a1)])
    .filter(([a0, a1]) => a1 > a0)
    .sort((p, q) => p[0] - q[0]);

  const spans = [];
  for (const span of raw) {
    const last = spans[spans.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else spans.push([span[0], span[1]]);
  }

  if (!spans.length) return [flatRing(r0, r1)];

  const out = [];
  for (let i = 0; i < spans.length; i++) {
    const start = spans[i][1];
    const end = spans[(i + 1) % spans.length][0] + (i + 1 === spans.length ? TAU : 0);
    if (end - start > 1e-4) out.push(sectorGeo(r0, r1, start, end));
  }
  return out;
}

/**
 * A radial strip, broken wherever another road crosses it.
 *
 * @param {Array<[number,number]>} gaps radius ranges to leave out
 */
export function radialRuns(a, s0, s1, w, off, gaps) {
  const spans = gaps
    .map(([g0, g1]) => [Math.max(s0, g0), Math.min(s1, g1)])
    .filter(([g0, g1]) => g1 > g0)
    .sort((p, q) => p[0] - q[0]);

  const out = [];
  let cursor = s0;
  for (const [g0, g1] of spans) {
    if (g0 - cursor > 1e-4) out.push(radialStrip(a, cursor, g0, w, off));
    cursor = Math.max(cursor, g1);
  }
  if (s1 - cursor > 1e-4) out.push(radialStrip(a, cursor, s1, w, off));
  return out;
}
