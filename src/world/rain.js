/**
 * GPU rain.
 *
 * 12,000 line segments whose world positions are computed entirely in the
 * vertex stage: each streak wraps inside a box that follows the camera, so
 * rain appears to stay put in the world while you fly through it, and nothing
 * is ever uploaded per frame beyond a clock.
 *
 * Ported from the original GLSL ShaderMaterial. The one subtlety is that the
 * old shader skipped the model matrix (`projectionMatrix * viewMatrix * p`)
 * because it built world positions directly. `positionNode` feeds the normal
 * model-view chain instead, which is equivalent only because this mesh sits
 * at the origin with an identity transform — so it must stay there.
 */
import * as THREE from '../../vendor/three.bundle.min.js';
import { TSL } from '../../vendor/three.bundle.min.js';

const { attribute, varying, uniform, float, vec3, mix } = TSL;

const BOX = 9;          // world units the wrap box spans (1 unit = 10 m)
const COUNT = 12000;

export function createRain(rng) {
  const u = {
    time:    uniform(0),
    cam:     uniform(new THREE.Vector3()),
    wind:    uniform(new THREE.Vector2(0.12, 0.05)),
    opacity: uniform(0),
    color:   uniform(new THREE.Color(0xcfd6de)),
  };

  // --- geometry: two vertices per streak, tagged head (0) and tail (1) ---
  const seed = new Float32Array(COUNT * 6);
  const tip = new Float32Array(COUNT * 2);
  const pos = new Float32Array(COUNT * 6);   // filled by the shader; needed for the draw call
  for (let i = 0; i < COUNT; i++) {
    const a = rng(), b = rng(), c = rng();
    seed.set([a, b, c, a, b, c], i * 6);     // both ends share a seed
    tip[i * 2] = 0;
    tip[i * 2 + 1] = 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(seed, 3));
  geo.setAttribute('tip', new THREE.BufferAttribute(tip, 1));

  // --- vertex: wrap each streak into the box around the camera ---
  const aSeed = attribute('seed', 'vec3');
  const aTip = attribute('tip', 'float');
  const B = float(BOX);
  const speed = float(0.9).add(aSeed.x.mul(0.25));

  const xz = u.cam.xz
    .add(aSeed.xz.mul(B * 7).sub(u.cam.xz).sub(u.wind.mul(u.time)).mod(B))
    .sub(B * 0.5);
  const y = u.cam.y
    .add(aSeed.y.mul(B * 5).sub(u.time.mul(speed)).sub(u.cam.y).mod(B))
    .sub(B * 0.5);

  // the tail trails along the wind and the fall direction
  const p = vec3(xz.x, y, xz.y).add(vec3(u.wind.x, speed, u.wind.y).mul(aTip).mul(0.055));

  const fade = varying(aTip.oneMinus());

  const material = new THREE.LineBasicNodeMaterial();
  material.positionNode = p;
  material.colorNode = u.color;
  material.opacityNode = u.opacity.mul(mix(float(0.15), float(0.9), fade));
  material.transparent = true;
  material.depthWrite = false;
  material.fog = false;

  const mesh = new THREE.LineSegments(geo, material);
  mesh.frustumCulled = false;
  mesh.visible = false;

  return { mesh, uniforms: u, BOX };
}
