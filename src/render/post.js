/**
 * Screen-space effect chain, written in TSL so it compiles to WGSL on the
 * WebGPU backend and GLSL on the WebGL2 fallback.
 *
 *   pre-pass   view normals + depth          (only when AO or SSR is on)
 *   scene      beauty + velocity + material, AO folded into indirect light
 *   SSR        wet-road reflections, added
 *   bloom      window and street-light glow, added
 *   resolve    TRAA where velocity is affordable, else FXAA
 *
 * AO goes in through `builtinAOContext` rather than being multiplied over the
 * finished frame. The distinction matters: multiplying darkens direct sunlight
 * too, which reads as dirt on the sunlit faces of the towers. Injected, it
 * occludes only the indirect term, so the shading between buildings deepens
 * while the lit faces stay lit.
 *
 * Everything that moves at runtime is a uniform. Rebuilding the graph
 * recompiles shaders and stutters, so it happens only when the tier changes
 * the shape of the chain, not its numbers.
 */
import * as THREE from '../../vendor/three.bundle.min.js';
import { TSL, ao, ssr, traa, bloom, fxaa } from '../../vendor/three.bundle.min.js';
import { TIERS } from './context.js';

const { pass, mrt, output, velocity, normalView, metalness, roughness,
        screenUV, builtinAOContext, uniform, vec2 } = TSL;

const AO_SAMPLES = { ultra: 16, high: 12, medium: 8, low: 6 };

export function createPostFX({ renderer, scene, camera, tier }) {
  // Owned by us, so they survive a rebuild and the app can keep its handles.
  const uBloomStrength = uniform(0.8);
  const uBloomThreshold = uniform(0.7);
  const uAOScale = uniform(1.0);

  let pipeline = null;
  let n = {};                 // the nodes of the current graph
  let current = tier;
  let wet = 0;                // remembered across rebuilds

  function build(key) {
    const T = TIERS[key];
    const useAO = T.fx.includes('ao');
    const useSSR = T.fx.includes('ssr');

    // --- pre-pass: view-space normals, and the depth that comes with them ---
    let prePass = null, prePassNormal = null, prePassDepth = null;
    if (useAO || useSSR) {
      prePass = pass(scene, camera);
      prePass.setMRT(mrt({ output: normalView }));
      prePassNormal = prePass.getTextureNode();
      prePassDepth = prePass.getTextureNode('depth');
    }

    // --- scene pass ---
    const scenePass = pass(scene, camera);
    const targets = { output };
    if (T.aa === 'traa') targets.velocity = velocity;
    if (useSSR) targets.material = vec2(metalness, roughness);
    scenePass.setMRT(mrt(targets));

    let aoNode = null;
    if (useAO) {
      aoNode = ao(prePassDepth, prePassNormal, camera);
      aoNode.resolutionScale = key === 'ultra' ? 1.0 : 0.5;
      aoNode.samples.value = AO_SAMPLES[key] ?? 8;
      // 1 world unit = 10 m, so this radius is ~22 m: wide enough to catch the
      // gap between towers, tight enough that open streets stay open.
      aoNode.radius.value = 2.2;
      aoNode.distanceExponent.value = 1.4;
      aoNode.thickness.value = 1.2;

      const aoTex = aoNode.getTextureNode().sample(screenUV).r;
      scenePass.contextNode = builtinAOContext(aoTex.mul(uAOScale).clamp(0, 1));
    }

    const beauty = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    let color = beauty;

    // --- SSR: the wet road ---
    let ssrNode = null;
    if (useSSR) {
      const matTex = scenePass.getTextureNode('material');
      ssrNode = ssr(beauty, depth, prePassNormal, {
        metalnessNode: matTex.r,
        roughnessNode: matTex.g,
        // Asphalt and paving are dielectrics. Without this the road — the one
        // surface the effect exists for — is discarded before it is traced.
        reflectNonMetals: true,
        stochastic: false,   // mirror trace + roughness blur: stable without a denoiser
        binaryRefine: key === 'ultra',
        camera,
      });
      ssrNode.resolutionScale = T.ssrQuality >= 0.6 ? 0.75 : 0.5;
      ssrNode.quality.value = T.ssrQuality;
      ssrNode.maxDistance.value = 8;      // ~80 m of reflected street
      ssrNode.thickness.value = 0.06;
      ssrNode.intensity.value = wet;      // dry roads reflect nothing
      color = color.add(ssrNode);
    }

    // --- bloom ---
    const bloomNode = bloom(color, uBloomStrength, 0.55, uBloomThreshold);
    color = color.add(bloomNode);

    // --- resolve ---
    const outputNode = T.aa === 'traa'
      ? traa(color, depth, scenePass.getTextureNode('velocity'), camera)
      : fxaa(color);

    const p = new THREE.RenderPipeline(renderer);
    p.outputNode = outputNode;

    return { pipeline: p, nodes: { prePass, scenePass, aoNode, ssrNode, bloomNode } };
  }

  function apply(key) {
    const built = build(key);
    pipeline = built.pipeline;
    n = built.nodes;
    current = key;
  }

  apply(tier);

  return {
    get tier() { return current; },
    get pipeline() { return pipeline; },

    /** 0 = dry, 1 = standing water. Drives SSR without touching the graph. */
    setWetness(v) {
      wet = Math.max(0, Math.min(1, v));
      if (n.ssrNode) n.ssrNode.intensity.value = wet;
    },
    setBloom(strength, threshold) {
      uBloomStrength.value = strength;
      uBloomThreshold.value = threshold;
    },
    setAOScale(v) { uAOScale.value = v; },

    /** Rebuild only when the graph shape actually differs. */
    setTier(key) {
      if (key === current) return false;
      const a = TIERS[current], b = TIERS[key];
      if (a.aa === b.aa && String(a.fx) === String(b.fx)) { current = key; return false; }
      apply(key);
      return true;
    },

    render() { pipeline.render(); },
  };
}
