/**
 * Traffic that knows where the junctions are.
 *
 * The old version advanced an angle or a radius per car and drew a dot. It
 * looked right from a kilometre up and fell apart at street level: cars drove
 * through each other, through red lights, and through the middle of junctions
 * at a constant 180 km/h.
 *
 * This keeps the same road network but models a lane as a closed loop with a
 * length, a list of stop lines, and cars ordered along it. Two rules do almost
 * all the work:
 *
 *   follow   never close on the car ahead faster than you can brake
 *   signal   treat a stop line you are not allowed to cross as a stopped car
 *
 * Both are the same calculation — the speed from which you can still stop in
 * the distance available, `sqrt(2·a·d)` — so a queue at a red light forms out
 * of the following rule rather than needing its own code. When the light turns
 * green the queue discharges from the front, which is the behaviour that makes
 * a junction look real.
 *
 * Cars never overtake, so their order within a lane never changes. That is
 * what keeps this O(n): each car looks at exactly one other car, the one at
 * the next index.
 */
import * as THREE from '../../vendor/three.bundle.min.js';
import { TAU, EDGE, ROAD_Y } from '../core/config.js';
import { R, rand, pick } from '../core/math.js';
import { advanceLane, wrap, CAR_LEN } from './traffic-rules.js';

const CRUISE_RING = 1.25;  // ~45 km/h
const CRUISE_BLVD = 1.55;  // ~56 km/h
const SPACING = 2.4;       // average headway when placing cars

const CAR_COLS = ['#f2f2f0', '#1c1d20', '#b8bcc0', '#6d7278', '#243a5a', '#8e1c1f', '#f2f2f0', '#1c1d20'];

/**
 * @param {object} o
 * @param {Array}  o.rings
 * @param {Array}  o.junctions      from planJunctions()
 * @param {Material} o.carMaterial
 * @param {Function} o.makePoints   (positions, colors, size) -> THREE.Points
 * @param {Function} o.signalGreen  (phase) -> boolean, read once per frame
 */
export function createTraffic({ rings, junctions, carMaterial, makePoints, signalGreen }) {
  const lanes = [];

  /** Ring lanes: position is arc length, so every distance is in world units. */
  rings.filter(g => g.main).forEach(g => {
    [-1, 1].forEach(dir => {
      [0.18, 0.34].forEach(f => {
        const r = g.r + dir * g.w * f;
        const L = TAU * r;
        const here = junctions.filter(j => Math.abs(j.r - g.r) < 1e-6);
        if (!here.length) return;

        // A stop line sits before the junction box on the approach side. `p`
        // always increases in the direction of travel, so for the lane running
        // the other way the junction is at the mirrored arc length — and once
        // it is, "before" is just minus, whichever way the lane points.
        const stops = here.map(j => {
          const jFwd = wrap(j.a, TAU) * r;
          const jp = dir > 0 ? jFwd : L - jFwd;
          const back = j.halfBlvd + 0.5;
          return { p: wrap(jp - back, L), phase: j.phase };
        }).sort((x, y) => x.p - y.p);

        lanes.push({
          kind: 'ring', r, dir, L, stops, cars: [],
          cruise: CRUISE_RING,
          place(p, out) {
            const a = (dir > 0 ? p : L - p) / r;
            out.x = r * Math.sin(a);
            out.z = r * Math.cos(a);
            out.rot = dir > 0 ? a : a + Math.PI;
          },
        });
      });
    });
  });

  /**
   * Boulevard lanes: straight runs looped end to end. Position increases in
   * the direction of travel, so the maths downstream does not care which way
   * the lane actually points.
   */
  for (let k = 0; k < 3; k++) {
    const a = k * TAU / 3;
    const R0 = 30, R1 = EDGE;
    const L = R1 - R0;
    [-3.4, -1.9, 1.9, 3.4].forEach(off => {
      const dir = off > 0 ? 1 : -1;
      const here = junctions.filter(j => j.k === k && j.r > R0 && j.r < R1);
      if (!here.length) return;

      const stops = here.map(j => {
        const back = j.halfRing + 0.5;
        const sStop = j.r - dir * back;
        return { p: wrap(dir > 0 ? sStop - R0 : R1 - sStop, L), phase: j.phase ^ 1 };
      }).sort((x, y) => x.p - y.p);

      lanes.push({
        kind: 'blvd', a, off, dir, L, stops, cars: [],
        cruise: CRUISE_BLVD,
        place(p, out) {
          const s = dir > 0 ? R0 + p : R1 - p;
          out.x = s * Math.sin(a) + off * Math.cos(a);
          out.z = s * Math.cos(a) - off * Math.sin(a);
          out.rot = a + (dir > 0 ? Math.PI / 2 : -Math.PI / 2);
        },
      });
    });
  }

  // --- populate, ordered along each lane so index+1 is always the car ahead ---
  let total = 0;
  lanes.forEach(lane => {
    const n = Math.max(2, Math.floor(lane.L / SPACING));
    for (let i = 0; i < n; i++) {
      lane.cars.push({
        p: (i + R() * 0.4) * (lane.L / n),
        v: lane.cruise * rand(0.7, 1),
        cruise: lane.cruise * rand(0.85, 1.12),
        idx: total++,
      });
    }
  });

  // --- meshes ---
  // wheels on the road: half the body height above the carriageway
  const bodyGeo = new THREE.BoxGeometry(CAR_LEN, 0.15, 0.2).translate(0, ROAD_Y + 0.075, 0);
  const body = new THREE.InstancedMesh(bodyGeo, carMaterial, total);
  body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  body.frustumCulled = false;
  body.receiveShadow = true;
  const _c = new THREE.Color();
  for (let i = 0; i < total; i++) body.setColorAt(i, _c.set(pick(CAR_COLS)).convertSRGBToLinear());

  // Head and tail lamps, split by which way the car faces relative to the eye.
  const heads = [], tails = [];
  lanes.forEach(lane => lane.cars.forEach(c => (lane.dir > 0 ? heads : tails).push(c)));
  heads.forEach((c, i) => { c.pi = i; c.tail = false; });
  tails.forEach((c, i) => { c.pi = i; c.tail = true; });
  const hp = makePoints(new Array(heads.length * 3).fill(0), null, 1.5);
  const tp = makePoints(new Array(tails.length * 3).fill(0), null, 1.5);

  const E = body.instanceMatrix.array;
  const out = { x: 0, z: 0, rot: 0 };

  function step(dt, lightsVisible) {
    const ha = hp.geometry.attributes.position.array;
    const ta = tp.geometry.attributes.position.array;

    // Signal state is the same for every car this frame, so resolve it once.
    const green = [signalGreen(0), signalGreen(1)];

    for (let li = 0; li < lanes.length; li++) {
      const lane = lanes[li];
      advanceLane(lane, dt, green);

      const cars = lane.cars;
      for (let i = 0; i < cars.length; i++) {
        const car = cars[i];
        lane.place(car.p, out);
        const co = Math.cos(out.rot), si = Math.sin(out.rot), o = car.idx * 16;
        E[o] = co; E[o + 1] = 0; E[o + 2] = -si; E[o + 3] = 0;
        E[o + 4] = 0; E[o + 5] = 1; E[o + 6] = 0; E[o + 7] = 0;
        E[o + 8] = si; E[o + 9] = 0; E[o + 10] = co; E[o + 11] = 0;
        E[o + 12] = out.x; E[o + 13] = 0; E[o + 14] = out.z; E[o + 15] = 1;

        if (lightsVisible) {
          const arr = car.tail ? ta : ha, j = car.pi * 3;
          arr[j] = out.x; arr[j + 1] = 0.45; arr[j + 2] = out.z;
        }
      }
    }

    body.instanceMatrix.needsUpdate = true;
    if (lightsVisible) {
      hp.geometry.attributes.position.needsUpdate = true;
      tp.geometry.attributes.position.needsUpdate = true;
    }
  }

  return { mesh: body, groups: [hp, tp], step, count: total, laneCount: lanes.length };
}
