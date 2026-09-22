/**
 * The car-following and signal rules, with no renderer in sight.
 *
 * Kept separate from traffic.js so it can be run headlessly: queue behaviour
 * is the kind of thing that looks plausible in motion and is wrong in ways you
 * only catch by counting. See scripts/test-traffic.mjs.
 *
 * Positions are arc length or metres along the lane — always increasing in the
 * direction of travel, which is what lets one set of rules serve a ring and a
 * straight boulevard alike.
 */

export const CAR_LEN = 0.46;   // 4.6 m
export const MIN_GAP = 0.22;
export const ACCEL = 0.85;
export const DECEL = 1.7;
export const BRAKE_HORIZON = 12;   // don't brake for a light a lap away

export const wrap = (d, L) => ((d % L) + L) % L;

/**
 * The fastest you can be going at distance `d` and still stop by braking at
 * DECEL. Used for the car ahead and for a red light alike, which is why a
 * queue at a signal needs no code of its own: the first car stops for the
 * light, and everyone behind stops for the car in front.
 */
export const approachSpeed = d => (d <= 0 ? 0 : Math.sqrt(2 * DECEL * d));

/**
 * Advance one lane by `dt`.
 *
 * @param {object} lane  {L, stops:[{p,phase}], cars:[{p,v,cruise}]} — cars
 *                       ordered so that index+1 is the car ahead
 * @param {number} dt
 * @param {boolean[]} green  indexed by phase
 */
export function advanceLane(lane, dt, green) {
  const { cars, L, stops } = lane;
  const n = cars.length;
  if (!n) return;

  for (let i = 0; i < n; i++) {
    const car = cars[i];
    const lead = cars[(i + 1) % n];

    let target = car.cruise;

    // follow. With a single car on the loop the "car ahead" is itself, which
    // reads as a zero gap and holds it at a standstill forever, so a lone car
    // has nothing in front of it.
    if (n > 1) {
      const gap = wrap(lead.p - car.p, L) - CAR_LEN - MIN_GAP;
      const follow = approachSpeed(gap);
      if (follow < target) target = follow;
    }

    // signal: nearest stop line ahead that is not green
    if (stops.length) {
      let best = Infinity;
      for (let s = 0; s < stops.length; s++) {
        if (green[stops[s].phase]) continue;
        const d = wrap(stops[s].p - car.p, L);
        if (d < best) best = d;
      }
      if (best < BRAKE_HORIZON) {
        const stop = approachSpeed(best - 0.08);
        if (stop < target) target = stop;
      }
    }

    const dv = target - car.v;
    car.v += Math.max(-DECEL * dt, Math.min(ACCEL * dt, dv));
    if (car.v < 0) car.v = 0;
    car.p = wrap(car.p + car.v * dt, L);
  }
}
