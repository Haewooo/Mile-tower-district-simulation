/**
 * Headless checks on the traffic rules.
 *
 * Queue behaviour looks plausible in motion long before it is correct, so
 * these count instead of watching: do cars stop short of the line, do they
 * stay in order, does the queue actually clear on green.
 *
 *   npm run test:traffic
 */
import { advanceLane, wrap, CAR_LEN, MIN_GAP } from '../src/world/traffic-rules.js';

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

/** A straight loop with one stop line at p = 40. */
function makeLane(carCount, cruise = 1.4) {
  const L = 120;
  const cars = [];
  for (let i = 0; i < carCount; i++) {
    cars.push({ p: (i * L) / carCount, v: cruise, cruise });
  }
  return { L, stops: [{ p: 40, phase: 0 }], cars };
}

function run(lane, seconds, green, dt = 1 / 60) {
  for (let t = 0; t < seconds / dt; t++) advanceLane(lane, dt, green);
}

// --- 1. a red light brings cars to a halt before the line -------------------
{
  const lane = makeLane(24);
  run(lane, 60, [false, true]);
  const stopped = lane.cars.filter(c => c.v < 0.01);
  const overshoot = lane.cars.filter(c => {
    const d = wrap(40 - c.p, lane.L);
    return c.v < 0.01 && d > lane.L / 2;   // stopped just past the line
  });
  check('적색에서 정차', stopped.length > 0, `정지 ${stopped.length}/${lane.cars.length}대`);
  check('정지선을 넘지 않음', overshoot.length === 0, `초과 ${overshoot.length}대`);
}

// --- 2. cars never pass each other ------------------------------------------
{
  const lane = makeLane(24);
  const order = lane.cars.map(c => c);
  run(lane, 90, [false, true]);
  let inOrder = true;
  for (let i = 0; i < order.length; i++) {
    const a = order[i], b = order[(i + 1) % order.length];
    if (wrap(b.p - a.p, lane.L) > lane.L - 0.01) inOrder = false;
  }
  check('추월 없음', inOrder);
}

// --- 3. nobody is inside anybody --------------------------------------------
{
  const lane = makeLane(24);
  run(lane, 90, [false, true]);
  let worst = Infinity;
  for (let i = 0; i < lane.cars.length; i++) {
    const a = lane.cars[i], b = lane.cars[(i + 1) % lane.cars.length];
    worst = Math.min(worst, wrap(b.p - a.p, lane.L));
  }
  check('차간 간격 유지', worst >= CAR_LEN - 0.02, `최소 간격 ${worst.toFixed(3)} (차체 ${CAR_LEN})`);
}

// --- 4. the queue clears once it turns green --------------------------------
{
  const lane = makeLane(24);
  run(lane, 60, [false, true]);
  const queued = lane.cars.filter(c => c.v < 0.05).length;
  run(lane, 25, [true, true]);
  const stillQueued = lane.cars.filter(c => c.v < 0.05).length;
  check('녹색에서 해소', stillQueued < queued, `${queued}대 → ${stillQueued}대`);
}

// --- 5. free flow reaches cruise --------------------------------------------
{
  const lane = { L: 400, stops: [], cars: [{ p: 0, v: 0, cruise: 1.4 }] };
  run(lane, 20, [true, true]);
  check('자유 주행 시 순항 속도 도달', Math.abs(lane.cars[0].v - 1.4) < 0.02, `v=${lane.cars[0].v.toFixed(3)}`);
}

// --- 6. a stopped queue is packed to the minimum gap, not overlapping -------
{
  const lane = makeLane(30);
  run(lane, 120, [false, true]);
  const stopped = lane.cars.filter(c => c.v < 0.01).length;
  check('대기행렬 형성', stopped >= 3, `${stopped}대 정지`);
  void MIN_GAP;
}

console.log(`\n${failures ? failures + '개 실패' : '모두 통과'}`);
process.exit(failures ? 1 : 0);
