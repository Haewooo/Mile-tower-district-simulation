/**
 * Colour conversion.
 *
 * `THREE.ColorManagement` is off in this app — colours are authored as sRGB
 * hex and converted explicitly, so every conversion is visible at the call
 * site rather than happening somewhere inside three.
 */
import * as THREE from '../../vendor/three.bundle.min.js';

/** sRGB hex or CSS colour -> linear-space THREE.Color. */
export const lin = h => new THREE.Color(h).convertSRGBToLinear();
