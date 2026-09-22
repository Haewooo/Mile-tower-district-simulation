/**
 * Procedural sky dome.
 *
 * Ported from the original GLSL ShaderMaterial: a horizon-to-zenith gradient,
 * a ground term below the horizon, and two sun lobes — a wide glow and a tight
 * disk. The GLSL version ended with tonemapping and colorspace includes
 * because it drew straight to the screen; the node pipeline applies both at
 * the end of the chain, so they are gone from here.
 */
import * as THREE from '../../vendor/three.bundle.min.js';
import { TSL } from '../../vendor/three.bundle.min.js';

const { positionLocal, mix, smoothstep, max, dot, vec4, uniform } = TSL;

export function createSky(radius = 3400) {
  const u = {
    top:    uniform(new THREE.Color()),
    hor:    uniform(new THREE.Color()),
    gnd:    uniform(new THREE.Color()),
    sunCol: uniform(new THREE.Color()),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    glow:   uniform(0),
    disk:   uniform(0),
  };

  const d = positionLocal.normalize();
  const h = d.y;

  // horizon -> zenith, then fade to the ground colour just below the horizon
  let c = mix(u.hor, u.top, h.clamp(0, 1).pow(0.5));
  c = mix(c, u.gnd, smoothstep(0, 0.12, h.negate()));

  // sun: a broad glow and a hard disk, both scaled by how high the sun is
  const s = max(dot(d, u.sunDir.normalize()), 0);
  c = c.add(u.sunCol.mul(s.pow(6).mul(0.25).add(s.pow(48).mul(0.5))).mul(u.glow));
  c = c.add(u.sunCol.mul(smoothstep(0.9993, 0.9997, s)).mul(u.disk).mul(3));

  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = vec4(c, 1);
  material.side = THREE.BackSide;
  material.depthWrite = false;
  material.depthTest = false;
  material.fog = false;
  material.toneMapped = false;

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), material);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;

  return { mesh, uniforms: u };
}
