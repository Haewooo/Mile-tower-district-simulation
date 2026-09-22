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
