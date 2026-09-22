/**
 * Building facades.
 *
 * A port of the original `onBeforeCompile` surgery on MeshStandardMaterial,
 * which reached into six different shader chunks. In TSL the same effects are
 * separate node assignments, which is both shorter and legible.
 *
 * What it does, unchanged from the GLSL version:
 *
 *  - Projects UVs from world position rather than mesh UVs, so one facade
 *    texture tiles across every building at a constant real-world scale no
 *    matter how the box was stretched.
 *  - Offsets those UVs per instance, so neighbouring towers do not line their
 *    windows up.
 *  - Parallax-maps an interior texture behind the glass, so windows read as
 *    rooms with depth instead of flat pictures.
 *  - Forces glass to metalness 0 / roughness 0.025 with a low-E specular tint.
 *  - Tilts each window pane a little, so reflections break up across a facade.
 *  - Darkens the lower floors, standing in for the ambient occlusion of the
 *    street canyon.
 *
 * Two details worth knowing:
 *
 * `varying()` is deliberate. The GLSL version computed these in the vertex
 * stage and let the rasteriser interpolate; recomputing per fragment would
 * change the radial mapping, where interpolating `atan` across a cylinder
 * facet is what keeps the seam from tearing.
 *
 * The material is Physical, not Standard, only because the glass needs
 * `specularColorNode`. Standard derives F0 from metalness and cannot be told
 * that this glass is coated.
 */
import * as THREE from '../../vendor/three.bundle.min.js';
import { TSL } from '../../vendor/three.bundle.min.js';

const {
  attribute, positionGeometry, positionWorld, normalWorld, cameraPosition,
  cameraViewMatrix, instanceIndex, texture, materialReference, normalMap,
  vec2, vec3, vec4, float, mix, dot, atan, select, fract, floor, sin,
  smoothstep, max, varying,
} = TSL;

const LOW_E = vec3(0.40, 0.46, 0.46);     // interior seen through coated glass
const GLASS_SPECULAR = vec3(0.085, 0.105, 0.12);

/**
 * @param {object} F   facade texture set: {map, nrm, emi, pbr, int, tw, th, floors, depth, bays, detail}
 * @param {object} opts material options; `radial` switches to cylindrical UVs
 * @param {object} deps {detailMap} — the concrete map used to break up solid wall
 */
export function createFacadeMaterial(F, opts = {}, deps = {}) {
  const { radial = false, ...materialOptions } = opts;
  const { detailMap } = deps;
  const tw = F.tw, th = F.th, floors = F.floors, depth = F.depth;
  const bays = F.bays || 12, det = F.detail || 0;

  const m = new THREE.MeshPhysicalNodeMaterial({
    roughness: 1,
    metalness: 1,
    emissive: 0xffffff,
    emissiveIntensity: 0,
    ...materialOptions,
  });

  // ---- world-projected UV, evaluated per vertex ----
  const nq = normalWorld.normalize();
  const tangent2 = vec2(nq.z.negate(), nq.x);
  const tlen = tangent2.length();
  const tq = select(tlen.greaterThan(1e-4), tangent2.div(tlen), vec2(1, 0));

  // Round buildings are instanced cylinders, so arc length needs the instance's
  // own X scale; `iscale` is written per chunk next to the instance matrix.
  const u = radial
    ? atan(positionGeometry.z, positionGeometry.x).mul(0.5).mul(attribute('iscale', 'float'))
    : dot(positionWorld.xz, tq);

  // instanceIndex is 0 on a non-instanced draw, so the jitter vanishes there
  const iid = float(instanceIndex);
  const wuv = varying(vec2(
    u.div(tw).add(fract(iid.mul(0.7548)).mul(17)),
    positionWorld.y.div(th).add(floor(fract(iid.mul(0.5698)).mul(floors)).div(floors)),
  ));

  const rayW = varying(positionWorld.sub(cameraPosition));
  const tanW = varying(vec3(tq.x, 0, tq.y));
  const nrmW = varying(nq);
  const worldY = varying(positionWorld.y);

  // ---- window mask ----
  // The packed PBR map keeps "is glass" in blue, the same channel three reads
  // for metalness, which is why glass is metal until we say otherwise below.
  const pbr = texture(F.pbr, wuv);
  const win = smoothstep(0.2, 0.34, pbr.b);

  // ---- interior parallax ----
  const ray = rayW.normalize();
  const facing = max(0.12, dot(ray, nrmW.normalize()).negate());
  const parallax = vec2(dot(ray, tanW.normalize()).div(tw), ray.y.div(th))
    .mul(float(depth).div(facing));

  const room = texture(F.int, wuv.add(parallax)).rgb;

  // ---- diffuse ----
  let diffuse = texture(F.map, wuv).rgb;
  diffuse = mix(diffuse, room.mul(LOW_E), win.mul(0.96));
  if (detailMap && det > 0) {
    const grain = texture(detailMap, wuv.mul(vec2(tw / 2.2, th / 2.2))).rgb.div(0.7);
    diffuse = diffuse.mul(mix(vec3(1), grain, win.oneMinus().mul(det)));
  }
  // street-canyon darkening toward the base
  diffuse = diffuse.mul(mix(float(0.5), float(1), smoothstep(0.1, 1.8, worldY)));
  m.colorNode = vec4(diffuse, 1);   // three multiplies instanceColor in on top

  // ---- emissive: lit rooms, sampled through the same parallax ----
  m.emissiveNode = texture(F.emi, wuv.add(parallax)).rgb
    .mul(materialReference('emissiveIntensity', 'float'));

  // ---- glass is not metal ----
  m.metalnessNode = mix(pbr.b, float(0), win);
  m.roughnessNode = mix(pbr.g, float(0.025), win);
  m.specularColorNode = mix(vec3(1), GLASS_SPECULAR, win);

  // ---- per-pane tilt, so a facade does not mirror as one flat sheet ----
  const cell = floor(wuv.mul(vec2(bays, floors)));
  const h1 = fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5453));
  const h2 = fract(sin(dot(cell, vec2(39.3468, 11.135))).mul(24634.6345));
  const tilt = tanW.normalize().mul(h1.sub(0.5)).add(vec3(0, 1, 0).mul(h2.sub(0.5)));
  const tiltView = cameraViewMatrix.mul(vec4(tilt, 0)).xyz;

  const mapped = normalMap(texture(F.nrm, wuv), vec2(0.9, 0.9));
  m.normalNode = mapped.add(tiltView.mul(0.07).mul(win)).normalize();

  return m;
}
