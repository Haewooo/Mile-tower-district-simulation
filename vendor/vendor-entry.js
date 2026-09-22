/**
 * Vendor bundle: three.js (WebGPU renderer + WebGL2 fallback backend), TSL,
 * and the screen-space effects the app composites.
 *
 * WebGPURenderer picks a WebGPU backend when the browser has one and falls
 * back to WebGL2 by itself, so the app has a single render path. TSL compiles
 * to WGSL or GLSL to match.
 *
 * Rebuild with:  npm run vendor
 */

// three core + WebGPU renderer, node materials, post-processing
export * from 'three/webgpu';

// TSL: the shading language the app writes custom materials in.
// Namespaced to keep names like `color`, `mix`, `time` out of the app's scope.
export * as TSL from 'three/tsl';

// Screen-space effects
export { ao }    from 'three/addons/tsl/display/GTAONode.js';        // ambient occlusion between buildings
export { ssr }   from 'three/addons/tsl/display/SSRNode.js';         // wet-road reflections
export { traa }  from 'three/addons/tsl/display/TRAANode.js';        // temporal antialiasing
export { bloom } from 'three/addons/tsl/display/BloomNode.js';       // window / street-light glow
export { fxaa }  from 'three/addons/tsl/display/FXAANode.js';        // cheap AA for the low quality tier
export { denoise } from 'three/addons/tsl/display/DenoiseNode.js';   // cleans up AO and SSR at low sample counts

// Loaders
export { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
