/**
 * Prints what covers each metre of a road cross-section, and at what height.
 *
 * Arguing about a stray white line from a screenshot is slow; this says which
 * surface is actually on top at a given offset from the centre line.
 *
 *   node scripts/cross-section.mjs
 */
const U = 0.1;                 // 1 metre in world units
const GROUND_Y = 0.020, ROAD_Y = 0.024, MARK_Y = 0.027, STREET_Y = 0.028, WALK_Y = 0.039;
const KERB = 0.03;

/** [from, to, label, height] — offsets in world units from the centre line. */
function minorSpoke() {
  const w = 1.8, half = w / 2;
  return [
    [-half, half, '차도 (아스팔트)', ROAD_Y],
    [-0.035, 0.035, '중앙선 (노랑)', MARK_Y],
    [half, half + KERB, '연석', WALK_Y],
    [-half - KERB, -half, '연석', WALK_Y],
    [half + KERB, half + KERB + (0.55 - KERB), '보도', WALK_Y],
    [-half - KERB - (0.55 - KERB), -half - KERB, '보도', WALK_Y],
  ];
}

function boulevard() {
  const half = 4;
  const out = [[-half, half, '차도 (아스팔트)', ROAD_Y]];
  [-1, 1].forEach(o => {
    out.push([o * 3.85 - 0.025, o * 3.85 + 0.025, '가장자리선 (흰색)', MARK_Y]);
    out.push([o * 2.65 - 0.03, o * 2.65 + 0.03, '차선 점선 (흰색)', MARK_Y]);
    out.push([o * (4.0 + KERB / 2) - KERB / 2, o * (4.0 + KERB / 2) + KERB / 2, '연석', WALK_Y]);
    const wIn = o * (4.3 + KERB / 2) - (0.6 - KERB) / 2, wOut = o * (4.3 + KERB / 2) + (0.6 - KERB) / 2;
    out.push([Math.min(wIn, wOut), Math.max(wIn, wOut), '보도', WALK_Y]);
  });
  return out;
}

function report(name, bands) {
  console.log('\n=== ' + name + ' ===');
  const lo = Math.min(...bands.map(b => b[0])) - 0.2;
  const hi = Math.max(...bands.map(b => b[1])) + 0.2;
  console.log(`  (중심선 기준 ${(lo * 10).toFixed(1)}m ~ ${(hi * 10).toFixed(1)}m)`);
  const sorted = [...bands].sort((a, b) => a[0] - b[0]);
  for (const [a, b, label, y] of sorted) {
    console.log(`  ${(a * 10).toFixed(2).padStart(8)}m ~ ${(b * 10).toFixed(2).padStart(8)}m  ` +
                `폭 ${((b - a) * 10).toFixed(2).padStart(6)}m  y=${y.toFixed(3)}  ${label}`);
  }
  // anything painted that sits outside the carriageway
  const road = sorted.find(b => b[2].startsWith('차도'));
  const strays = sorted.filter(b => /흰색/.test(b[2]) && (b[0] < road[0] || b[1] > road[1]));
  console.log(strays.length ? '  ⚠ 차도를 벗어난 표시: ' + strays.map(s => s[2]).join(', ')
                            : '  ✓ 흰색 표시는 모두 차도 안');
  void GROUND_Y; void STREET_Y; void U;
}

report('간선 도로 (폭 18m)', minorSpoke());
report('대로 (폭 80m)', boulevard());
