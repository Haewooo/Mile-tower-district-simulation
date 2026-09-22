/**
 * Deterministic randomness and the noise the terrain is shaped with.
 *
 * Every procedural decision in the city draws from `R`, a single seeded
 * stream. That makes the city reproducible — and it makes call order part of
 * the output: pulling one extra number early shifts everything downstream.
 * Moving code around is safe; reordering the draws is not.
 */
import { SEED, RIVER } from './config.js';

/** mulberry32. Small, fast, and good enough for scattering buildings. */
export function rng(seed) {
  return function () {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** The city's stream. Shared, ordered, load-bearing. */
export const R = rng(SEED);

export const rand = (a, b) => a + R() * (b - a);
export const pick = a => a[Math.floor(R() * a.length)];
export const polar = (r, t) => [r * Math.sin(t), r * Math.cos(t)];

/** Quantise a height to whole floors (4 m). */
export const floorQ = h => Math.max(0.4, Math.round(h / 0.4) * 0.4);

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Perpendicular distance from the river's centre line. */
export const riverD = (x, z) => Math.abs(x * Math.cos(RIVER.a) - z * Math.sin(RIVER.a) - RIVER.d);

/**
 * Value noise on a 256² lattice, smoothstep-interpolated. Cheap, tiles by
 * wrapping, and drives both the fractal height field and the ridge lines of
 * the far hills.
 */
export function makeNoise(seed) {
  const r = rng(seed), N = 256, P = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) P[i] = r();
  const at = (x, y) => P[((y & 255) << 8) + (x & 255)];
  return function (x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return at(xi, yi) * (1 - u) * (1 - v) + at(xi + 1, yi) * u * (1 - v)
         + at(xi, yi + 1) * (1 - u) * v + at(xi + 1, yi + 1) * u * v;
  };
}

export const NOISE = makeNoise(9137);
export const NOISE2 = makeNoise(5521);

/** Fractal sum of `oct` octaves, normalised to 0..1. */
export function fbm(n, x, y, oct) {
  let v = 0, a = 0.5, f = 1, s = 0;
  for (let i = 0; i < oct; i++) { v += a * n(x * f, y * f); s += a; f *= 2; a *= 0.5; }
  return v / s;
}
