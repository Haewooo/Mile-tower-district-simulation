import * as T from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
// one namespace object for the app, with the addons it uses
export const THREE = Object.assign({}, T, { EffectComposer, RenderPass, UnrealBloomPass, OutputPass, EXRLoader });
