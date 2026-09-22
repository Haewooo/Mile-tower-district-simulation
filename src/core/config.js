/**
 * The numbers the city is built from.
 *
 * 1 world unit = 10 m. Colours are authored in sRGB and converted to linear
 * where they are used, not here, so these stay readable as hex.
 */

export const TAU = Math.PI * 2;

/** Outer edge of the planned district, in world units (4.7 km). */
export const EDGE = 470;

/** Zone boundaries by radius: core, inner, mid, outer, fringe. */
export const ZB = [58, 120, 200, 290, 390, EDGE];

/** The river: angle, signed distance from origin, half-width, bank width. */
export const RIVER = { a: 0.35, d: -255, half: 18, bank: 14 };

/** The tower: podium top, segment count, segment height, gap, crown height (1,609 m). */
export const TOWER = { y0: 6, nseg: 10, segH: 14.4, gap: 1.5, top: 160.9 };

/** Silhouettes for scale comparison. */
export const GHOSTS = [
  { name: '롯데월드타워 555m', th: 110 / 360 * TAU, r: 46 },
  { name: '부르즈 할리파 828m', th: 330 / 360 * TAU, r: 46 },
];

export const ROAD_Y = 0.14;

/** Chunking: angular sectors, and the radial bands they are cut into. */
export const CH_SECT = 16;
export const BANDS = [0, 90, 160, 240, 330, 1e9];

/**
 * Lighting presets the clock interpolates between. `sunDir` is a direction,
 * not a position; everything else is either a colour or a scalar listed in
 * COLOR_KEYS / NUM_KEYS below, which is how the blend knows what to lerp.
 */
export const PRESETS = {
  day: {
    skyTop: '#3a72b0', skyHor: '#cfdfeb', skyGround: '#9ea6a6', sunCol: '#fff2d6', sunGlow: 0.35, sunDisk: 0.6,
    fog: '#c9d8e6', fogNear: 320, fogFar: 2600, hemiSky: '#dfeaf6', hemiGround: '#6e6a60', hemiI: 0.42,
    lightCol: '#fff1dc', lightI: 2.1, sunDir: [0.5, 0.72, 0.45], exposure: 1.0,
    glow: 0, garden: 0, fins: 0, street: 0, traffic: 0, bloom: 0, bloomThr: 0.9, stars: 0,
    cloud: '#ffffff', cloudOp: 0.95, roadGlow: 0,
  },
  sunset: {
    skyTop: '#23315a', skyHor: '#f6a262', skyGround: '#6a5560', sunCol: '#ffb070', sunGlow: 1.1, sunDisk: 1.0,
    fog: '#d6a08f', fogNear: 600, fogFar: 3000, hemiSky: '#f7cfb0', hemiGround: '#4a4666', hemiI: 0.7,
    lightCol: '#ffb070', lightI: 2.4, sunDir: [0.97, 0.16, -0.05], exposure: 1.0,
    glow: 0.28, garden: 0.55, fins: 0.35, street: 0.45, traffic: 0.5, bloom: 0.45, bloomThr: 0.75, stars: 0,
    cloud: '#ffc3a0', cloudOp: 0.95, roadGlow: 0.05,
  },
  night: {
    skyTop: '#02050d', skyHor: '#121c33', skyGround: '#05070c', sunCol: '#9fb3e0', sunGlow: 0.18, sunDisk: 0.9,
    fog: '#0b1322', fogNear: 600, fogFar: 3200, hemiSky: '#2a3a5c', hemiGround: '#05060a', hemiI: 0.35,
    lightCol: '#9db3ff', lightI: 0.35, sunDir: [0.35, 0.55, -0.45], exposure: 1.15,
    glow: 0.6, garden: 0.8, fins: 0.9, street: 1.0, traffic: 1.0, bloom: 0.5, bloomThr: 0.78, stars: 1,
    cloud: '#28324a', cloudOp: 0.5, roadGlow: 0.22,
  },
};

export const COLOR_KEYS = ['skyTop', 'skyHor', 'skyGround', 'sunCol', 'fog', 'hemiSky', 'hemiGround', 'lightCol', 'cloud'];
export const NUM_KEYS = ['sunGlow', 'sunDisk', 'fogNear', 'fogFar', 'hemiI', 'lightI', 'exposure', 'glow',
                         'garden', 'fins', 'street', 'traffic', 'bloom', 'bloomThr', 'stars', 'cloudOp', 'roadGlow'];

/** Camera presets behind the view buttons. */
export const VIEWS = {
  bird:   { tx: 0, ty: 60, tz: 0, r: 430,  phi: 1.08, theta: 0.75 },
  plan:   { tx: 0, ty: 0,  tz: 0, r: 1250, phi: 0.3,  theta: 0.75 },
  ground: { tx: 0, ty: 60, tz: 0, r: 64.4, phi: 2.69, theta: 0.4 },
  street: { tx: 0, ty: 14, tz: 78, r: 26,  phi: 2.35, theta: 0.2 },
  top:    { tx: 0, ty: 150, tz: 0, r: 70,  phi: 1.25, theta: 1.0 },
};

/** Seed for every procedural decision. Change it and you get a different city. */
export const SEED = 20260920;

/** Site for the solar model: 37.5°N, autumn equinox. */
export const SITE = { lat: 37.5 * Math.PI / 180, day: 264 };
