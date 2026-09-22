/**
 * Renderer, capabilities and quality tiers.
 *
 * One render path: WebGPURenderer drives a WebGPU backend where the browser
 * has one and falls back to WebGL2 by itself, and TSL compiles to WGSL or
 * GLSL to match. What differs between the two is not the code but what we
 * dare switch on, which is what the tier below decides.
 *
 * Depth is the hinge. The camera spans 0.08 to 9000 world units (6 m to 40 km),
 * which a 24-bit depth buffer cannot resolve — the original build bought its
 * way out with `logarithmicDepthBuffer`, and paid for it by making every
 * depth-reading effect impossible: GTAO, SSR and TRAA all reconstruct view
 * position from depth and all of them break under a logarithmic curve.
 *
 * A reversed float depth buffer solves the same precision problem without
 * that cost, so we ask for one and let the effects follow it: where we get
 * it, screen-space effects are on; where we don't, we go back to logarithmic
 * depth and drop to FXAA. `renderer.reversedDepthBuffer` reports what we
 * actually got — three silently downgrades when EXT_clip_control is missing
 * on the WebGL2 path — so the tier is read back from the renderer, never
 * assumed.
 */
import * as THREE from '../../vendor/three.bundle.min.js';

/** Quality tiers, cheapest last. `fx` names the screen-space effects a tier affords. */
export const TIERS = {
  ultra:  { label: '최고', pixelRatio: 1.5,  shadowMap: 4096, aa: 'traa',  fx: ['ao', 'ssr'], aoQuality: 'high', ssrQuality: 0.6 },
  high:   { label: '높음', pixelRatio: 1.25, shadowMap: 3072, aa: 'traa',  fx: ['ao', 'ssr'], aoQuality: 'medium', ssrQuality: 0.4 },
  medium: { label: '보통', pixelRatio: 1.0,  shadowMap: 2048, aa: 'traa',  fx: ['ao'],        aoQuality: 'low', ssrQuality: 0 },
  low:    { label: '낮음', pixelRatio: 1.0,  shadowMap: 1024, aa: 'fxaa',  fx: [],            aoQuality: 'low', ssrQuality: 0 },
};

export const CAPS = {
  webgpu: false,        // WebGPU backend, not the WebGL2 fallback
  reversedDepth: false, // float reversed depth — gates every screen-space effect
  maxAnisotropy: 1,
  maxTextureSize: 2048,
  deviceMemory: navigator.deviceMemory || 4,
  cores: navigator.hardwareConcurrency || 4,
  coarsePointer: matchMedia('(pointer: coarse)').matches,
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
};

/** Has the browser got a WebGPU adapter we can actually use? */
export async function probeWebGPU() {
  if (!navigator.gpu) return false;
  try { return !!(await navigator.gpu.requestAdapter()); }
  catch { return false; }
}

/**
 * Largest 2D texture the device will allocate.
 *
 * The old `renderer.capabilities.maxTextureSize` is gone — the node renderer
 * keeps capabilities on the backend, and neither backend republishes this one,
 * so it comes from the underlying device or context. A conservative 2048 if
 * neither answers, which only costs shadow resolution.
 */
function readMaxTextureSize(renderer) {
  const backend = renderer.backend;
  const wgpuLimit = backend?.device?.limits?.maxTextureDimension2D;
  if (wgpuLimit) return wgpuLimit;
  const gl = backend?.gl;
  if (gl) { try { return gl.getParameter(gl.MAX_TEXTURE_SIZE); } catch { /* fall through */ } }
  return 2048;
}

/**
 * Pick a starting tier. This is a guess from static capability — the frame
 * pacer in quality.js is what actually settles it once frames are flowing.
 */
function guessTier() {
  if (!CAPS.reversedDepth) return 'low';           // no depth-based effects available
  if (CAPS.coarsePointer) return CAPS.webgpu && CAPS.deviceMemory >= 6 ? 'medium' : 'low';
  if (!CAPS.webgpu) return 'medium';               // WebGL2 fallback: effects work but cost more
  if (CAPS.deviceMemory >= 8 && CAPS.cores >= 8) return 'ultra';
  return 'high';
}

/**
 * Build the renderer and fill in CAPS. Resolves once the backend is up, so
 * callers can read real capabilities rather than hopeful defaults.
 */
export async function createRenderer(canvas) {
  const webgpu = await probeWebGPU();

  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: false,             // TRAA/FXAA resolve instead; MSAA costs more than it returns here
    alpha: false,
    powerPreference: 'high-performance',
    reversedDepthBuffer: true,    // opt-in; three reports back whether it stuck
    // Only meaningful if reversed depth is refused — see the note above.
    logarithmicDepthBuffer: false,
  });

  await renderer.init();

  CAPS.webgpu = webgpu && renderer.backend?.isWebGPUBackend === true;
  CAPS.reversedDepth = renderer.reversedDepthBuffer === true;
  CAPS.maxAnisotropy = renderer.getMaxAnisotropy();
  CAPS.maxTextureSize = readMaxTextureSize(renderer);

  // Without reversed depth the far plane would z-fight itself apart, so put
  // the logarithmic buffer back and accept that screen-space effects are out.
  if (!CAPS.reversedDepth) {
    renderer.logarithmicDepthBuffer = true;
  }

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const tier = guessTier();
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, TIERS[tier].pixelRatio));

  return { renderer, tier, caps: CAPS };
}

/** One line for the diagnostics overlay and the console. */
export function describe(tier) {
  return [
    CAPS.webgpu ? 'WebGPU' : 'WebGL2 폴백',
    CAPS.reversedDepth ? 'reversed-Z float depth' : '로그 깊이 (화면공간 효과 불가)',
    `품질 ${TIERS[tier].label}`,
    `이방성 ${CAPS.maxAnisotropy}x`,
  ].join(' · ');
}
