/**
 * 1마일 타워 지구 — entry point.
 *
 * The original single-file program, now built by esbuild, with the pieces
 * that had to be rewritten for WebGPU already extracted into modules:
 * the renderer and its quality tiers, the screen-space effect chain, and the
 * three custom shaders (sky, rain, facades) that are now TSL.
 *
 * The rest of the city is still inline below and is being moved out section
 * by section. `boot()` is the old IIFE — several early-failure paths `return`
 * out of it — and is async now because the WebGPU backend comes up on a
 * promise.
 */
import * as T from '../vendor/three.bundle.min.js';
import { createRenderer, describe, CAPS } from './render/context.js';
import { createPostFX } from './render/post.js';
import { createSky } from './world/sky.js';
import { createRain } from './world/rain.js';
import { createFacadeMaterial } from './materials/facade.js';
import { createTraffic } from './world/traffic.js';
import { lampGeometry, lampLensGeometry, signalGeometry, signalLensGeometry,
         bollardGeometry, benchGeometry, planStreetFurniture,
         crossingGeometry, planJunctions, STREET_Y } from './world/street.js';
import { TAU, EDGE, ZB, RIVER, TOWER, GHOSTS, ROAD_Y, WALK_Y, MARK_Y, CH_SECT, BANDS,
         PRESETS, COLOR_KEYS, NUM_KEYS, VIEWS, SITE } from './core/config.js';
import { rng, R, rand, pick, polar, floorQ, clamp, smooth, riverD,
         NOISE, NOISE2, fbm, hash2 } from './core/math.js';
import { lin } from './core/color.js';
import { mergeGeos, sectorGeo, radialStrip, flatRing,
         ringArcs, radialRuns } from './core/geometry.js';

// the app was written against a single `THREE` namespace object
const THREE = T;
THREE.ColorManagement.enabled = false;

async function boot() {
'use strict';
const $=s=>document.querySelector(s);

// The shell in index.html owns the failure panel, because it has to work even
// when this bundle is the thing that failed.
function fail(title,advice,detail){
  if(window.__fail)window.__fail(title||'이 기기에서 3D를 표시할 수 없습니다.',advice||'',detail||'');
  else{const l=$('#loading');if(l)l.hidden=true;const e=$('#err');if(e)e.hidden=false;}
}

// Startup is several seconds of generation on a cold cache; naming the stage
// is the difference between "working" and "hung". Each step yields a frame —
// without that the whole boot runs between two paints and only the last label
// is ever seen, which is exactly the freeze it is meant to explain.
const nextFrame=()=>new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0)));
async function step(label){
  const el=$('#loadStep');
  if(el)el.textContent=label?' · '+label:'';
  await nextFrame();
}


/* ===================== Renderer ===================== */
const canvas=$('#c');
let renderer,tier;
try{({renderer,tier}=await createRenderer(canvas));}
catch(e){console.error('renderer init failed',e);
  fail('3D 렌더러를 시작할 수 없습니다.','이 브라우저는 WebGPU와 WebGL2를 모두 지원하지 않습니다. 최신 Chrome, Edge, Safari에서 다시 열어 주세요.',String(e&&e.message||e));return;}
const ANISO=CAPS.maxAnisotropy;
console.info('렌더러: '+describe(tier));
const scene=new THREE.Scene();
scene.fog=new THREE.Fog(0xc9d8e6,320,2600);
const camera=new THREE.PerspectiveCamera(40,1,0.08,9000);

/* ===================== Facade texture factory ===================== */
await step('재질 생성');
function makeCanvas(s){const c=document.createElement('canvas');c.width=c.height=s;return [c,c.getContext('2d')];}
function tex(cv,srgb){const t=new THREE.CanvasTexture(cv);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=ANISO;if(srgb)t.colorSpace=THREE.SRGBColorSpace;return t;}
function heightToNormal(hc,strength){
  const s=hc.width,src=hc.getContext('2d').getImageData(0,0,s,s).data,[c,g]=makeCanvas(s),img=g.createImageData(s,s);
  const H=(x,y)=>src[(((y+s)%s)*s+((x+s)%s))*4]/255;
  for(let y=0;y<s;y++)for(let x=0;x<s;x++){
    const dx=(H(x+1,y)-H(x-1,y))*strength,dy=(H(x,y+1)-H(x,y-1))*strength;
    const nx=-dx,ny=-dy,nz=1,l=Math.hypot(nx,ny,nz),i=(y*s+x)*4;
    img.data[i]=(nx/l*0.5+0.5)*255;img.data[i+1]=(ny/l*0.5+0.5)*255;img.data[i+2]=(nz/l*0.5+0.5)*255;img.data[i+3]=255;
  }
  g.putImageData(img,0,0);return tex(c,false);
}
const WARM=['#ffd9a3','#fff0d4','#ffe2b8','#ffcf8f'],COOL=['#d6e6ff','#e8f0ff','#cfe0f5'];
const ROOM_WALL=['#6a6258','#5c5f63','#6f6a5f','#585b52','#726a5e','#5a5550'];
const ROOM_FURN=['#8a7f6d','#6f7a82','#7d7466','#8e8676','#5f6a72'];
/*
  Every facade produces five maps that share one grid:
   map(colour) · nrm(relief) · pbr(G=roughness,B=metalness/window mask) · emi(lit rooms) · int(interior for parallax)
*/
// A lit room seen at night: ceiling luminaire strip, light falling off toward the floor,
// optional blind, furniture/people silhouettes, the odd monitor; brightness and colour temperature vary per room.
const ROOM_K=[[255,214,160],[255,226,184],[255,238,214],[240,242,255],[226,236,255]];
function paintLitRoom(ge,x,y,w,h,cols){
  const k=pick(ROOM_K),I=rand(0.28,0.95),rgb=(m,a)=>'rgba('+Math.round(k[0]*m)+','+Math.round(k[1]*m)+','+Math.round(k[2]*m)+','+a+')';
  const gr=ge.createLinearGradient(0,y,0,y+h);
  gr.addColorStop(0,rgb(I,1));gr.addColorStop(0.22,rgb(I*0.8,1));gr.addColorStop(0.7,rgb(I*0.42,1));gr.addColorStop(1,rgb(I*0.22,1));
  ge.fillStyle=gr;ge.fillRect(x,y,w,h);
  ge.fillStyle=rgb(Math.min(1,I*1.25),1);ge.fillRect(x+w*0.08,y+h*0.04,w*0.84,Math.max(1,h*0.05));
  if(R()<0.35){const bh=h*rand(0.2,0.7);ge.fillStyle=rgb(I*0.35,0.92);ge.fillRect(x,y,w,bh);
    ge.fillStyle='rgba(0,0,0,0.25)';for(let yy=y+2;yy<y+bh;yy+=3)ge.fillRect(x,yy,w,1);}
  if(R()<0.65){ge.fillStyle='rgba(0,0,0,0.55)';const n=1+Math.floor(R()*3);
    for(let i=0;i<n;i++){const dw=w*rand(0.15,0.4),dh=h*rand(0.12,0.28);ge.fillRect(x+rand(0,w-dw),y+h-dh-h*0.02,dw,dh);}}
  if(R()<0.25){ge.fillStyle='rgba(0,0,0,0.6)';const pw=w*0.08,px=x+rand(0.1,0.85)*w;ge.fillRect(px,y+h*0.45,pw,h*0.55);ge.beginPath();ge.arc(px+pw/2,y+h*0.4,pw*0.7,0,TAU);ge.fill();}
  if(R()<0.3){ge.fillStyle='rgba(150,190,255,0.8)';ge.fillRect(x+rand(0.1,0.8)*w,y+h*0.62,w*0.1,h*0.07);}
}
function buildFacade(o){
  const S=o.size||512,SI=o.interiorSize||512;
  const [cm,g]=makeCanvas(S),[ch,gh]=makeCanvas(S),[cp,gp]=makeCanvas(S),[ce,ge]=makeCanvas(SI),[ci,gi]=makeCanvas(SI);
  const fh=S/o.floors,bw=S/o.bays,fhi=SI/o.floors,bwi=SI/o.bays;
  g.fillStyle=o.wall;g.fillRect(0,0,S,S);
  gh.fillStyle='rgb(128,128,128)';gh.fillRect(0,0,S,S);
  gp.fillStyle='rgb(0,'+Math.round(o.wallPBR[0]*255)+','+Math.round(o.wallPBR[1]*255)+')';gp.fillRect(0,0,S,S);
  ge.fillStyle='#000';ge.fillRect(0,0,SI,SI);
  gi.fillStyle='#0b0b0c';gi.fillRect(0,0,SI,SI);
  for(let f=0;f<o.floors;f++)for(let b=0;b<o.bays;b++){
    const x=b*bw,y=f*fh;
    const win=o.cell(g,gh,x,y,bw,fh,b,f);
    if(!win)continue;
    // roughness / metalness (also the window mask used by the interior shader)
    gp.fillStyle='rgb(0,'+Math.round(clamp(o.winPBR[0]*rand(0.8,1.25),0,1)*255)+','+Math.round(o.winPBR[1]*255)+')';
    gp.fillRect(win[0],win[1],win[2],win[3]);
    // interior: ceiling / back wall / floor / furniture, drawn on the low-res grid
    const ix=win[0]/S*SI,iy=win[1]/S*SI,iw=win[2]/S*SI,ih=win[3]/S*SI;
    const wall=pick(ROOM_WALL);
    gi.fillStyle=wall;gi.fillRect(ix-1,iy-1,iw+2,ih+2);
    gi.fillStyle='#8d8a82';gi.fillRect(ix-1,iy-1,iw+2,Math.max(1,ih*0.17));
    gi.fillStyle='#3b3833';gi.fillRect(ix-1,iy+ih*0.72,iw+2,Math.max(1,ih*0.3));
    if(R()<0.75){const w2=iw*rand(0.25,0.6),h2=ih*rand(0.2,0.45);gi.fillStyle=pick(ROOM_FURN);gi.fillRect(ix+rand(0,iw-w2),iy+ih-h2-ih*0.22,w2,h2);}
    if(R()<0.45){const w2=iw*rand(0.1,0.3);gi.fillStyle='#4a4741';gi.fillRect(ix+rand(0,iw-w2),iy+ih*0.2,w2,ih*0.6);}
    if(R()<o.litP)paintLitRoom(ge,ix,iy,iw,ih,o.litCols);
  }
  ge.globalAlpha=1;
  return {map:tex(cm,true),nrm:heightToNormal(ch,o.relief||2.4),pbr:tex(cp,false),emi:tex(ce,true),int:tex(ci,true),tw:o.tw,th:o.th,floors:o.floors,bays:o.bays,depth:o.depth||0.22,detail:o.detail||0};
}
const H=v=>'rgb('+Math.round(v*255)+','+Math.round(v*255)+','+Math.round(v*255)+')';
// cell painters -----------------------------------------------------------
function cellCurtain(paneA,paneB,spandrel,mullion){return function(g,gh,x,y,w,h){
  g.fillStyle=mullion;g.fillRect(x,y,w,h);
  gh.fillStyle=H(0.72);gh.fillRect(x,y,w,h);
  const px=x+Math.max(1,w*0.05),py=y+Math.max(1,h*0.04),pw=w-Math.max(2,w*0.1),ph=h*0.74;
  const gr=g.createLinearGradient(0,y,0,y+h);gr.addColorStop(0,paneA);gr.addColorStop(1,paneB);
  g.fillStyle=gr;g.fillRect(px,py,pw,ph);
  g.fillStyle=spandrel;g.fillRect(px,y+h*0.8,pw,h*0.18);
  gh.fillStyle=H(0.3);gh.fillRect(px,py,pw,ph);
  gh.fillStyle=H(0.55);gh.fillRect(px,y+h*0.8,pw,h*0.18);
  return [px,py,pw,ph];};}
function cellPrecast(wall,frame,glass){return function(g,gh,x,y,w,h){
  g.fillStyle=wall;g.fillRect(x,y,w,h);gh.fillStyle=H(0.62);gh.fillRect(x,y,w,h);
  g.fillStyle=frame;g.fillRect(x+w*0.12,y+h*0.12,w*0.76,h*0.66);
  gh.fillStyle=H(0.78);gh.fillRect(x+w*0.12,y+h*0.12,w*0.76,h*0.66);
  const px=x+w*0.17,py=y+h*0.17,pw=w*0.66,ph=h*0.56;
  g.fillStyle=glass;g.fillRect(px,py,pw,ph);gh.fillStyle=H(0.26);gh.fillRect(px,py,pw,ph);
  g.fillStyle='rgba(0,0,0,0.12)';g.fillRect(x,y+h*0.84,w,h*0.04);
  return [px,py,pw,ph];};}
function cellBrick(wall,glass){return function(g,gh,x,y,w,h,b,f){
  g.fillStyle=wall;g.fillRect(x,y,w,h);gh.fillStyle=H(0.6);gh.fillRect(x,y,w,h);
  for(let r=0;r<6;r++){g.fillStyle='rgba(0,0,0,'+(0.05+R()*0.05)+')';g.fillRect(x,y+h*r/6,w,1);}
  const px=x+w*0.22,py=y+h*0.2,pw=w*0.56,ph=h*0.52;
  g.fillStyle='#d8d2c6';g.fillRect(px-2,py-2,pw+4,ph+4);gh.fillStyle=H(0.8);gh.fillRect(px-2,py-2,pw+4,ph+4);
  g.fillStyle=glass;g.fillRect(px,py,pw,ph);gh.fillStyle=H(0.3);gh.fillRect(px,py,pw,ph);
  return [px,py,pw,ph];};}
function cellApt(){return function(g,gh,x,y,w,h,b){
  g.fillStyle='#f1f0eb';g.fillRect(x,y,w,h);gh.fillStyle=H(0.6);gh.fillRect(x,y,w,h);
  const px=x+1,py=y+h*0.12,pw=w-2,ph=h*0.48;
  g.fillStyle='#74838f';g.fillRect(px,py,pw,ph);gh.fillStyle=H(0.32);gh.fillRect(px,py,pw,ph);
  g.fillStyle='#fbfbf8';g.fillRect(x,y+h*0.62,w,h*0.07);gh.fillStyle=H(0.85);gh.fillRect(x,y+h*0.62,w,h*0.07);
  if(b%4===0){g.fillStyle='#d6d4cc';g.fillRect(x,y,Math.max(2,w*0.14),h);gh.fillStyle=H(0.72);gh.fillRect(x,y,Math.max(2,w*0.14),h);}
  return [px,py,pw,ph];};}
function cellRetail(){return function(g,gh,x,y,w,h,b,f){
  const shop=['#cbb89b','#b9c3c9','#c8a9a0','#aebfae','#c9c2b0'][Math.floor(R()*5)];
  g.fillStyle=shop;g.fillRect(x,y,w,h);gh.fillStyle=H(0.62);gh.fillRect(x,y,w,h);
  g.fillStyle='#2e3338';g.fillRect(x,y,w,h*0.16);gh.fillStyle=H(0.8);gh.fillRect(x,y,w,h*0.16);
  if(R()<0.5){g.fillStyle=['#c0392b','#2c6fad','#d9a441','#2f7d55'][Math.floor(R()*4)];g.fillRect(x+w*0.1,y+h*0.03,w*0.8,h*0.1);}
  const px=x+w*0.06,py=y+h*0.2,pw=w*0.88,ph=h*0.7;
  g.fillStyle='#58656d';g.fillRect(px,py,pw,ph);gh.fillStyle=H(0.3);gh.fillRect(px,py,pw,ph);
  return [px,py,pw,ph];};}
const FACADES={
  curtainCool:buildFacade({size:512,floors:16,bays:16,tw:4.8,th:6.4,wall:'#b9c2c8',depth:0.3,relief:2.2,
    cell:cellCurtain('#7d94a8','#4f6376','#333c46','#b9c3cb'),wallPBR:[0.5,0.55],winPBR:[0.05,0.6],litP:0.36,litCols:COOL.concat(WARM)}),
  curtainWarm:buildFacade({size:512,floors:16,bays:14,tw:4.5,th:6.4,wall:'#bdb2a2',depth:0.3,relief:2.2,
    cell:cellCurtain('#9c8e74','#6d5f47','#453b2c','#c4b79f'),wallPBR:[0.5,0.5],winPBR:[0.06,0.6],litP:0.4,litCols:WARM}),
  precast:buildFacade({detail:0.55,size:512,floors:16,bays:12,tw:6.0,th:6.4,wall:'#d9d5cc',depth:0.26,relief:3.2,
    cell:cellPrecast('#d9d5cc','#c6c1b6','#46535e'),wallPBR:[0.9,0],winPBR:[0.08,0.45],litP:0.36,litCols:WARM}),
  brick:buildFacade({detail:0.25,size:512,floors:16,bays:12,tw:6.0,th:6.4,wall:'#a5705a',depth:0.24,relief:3,
    cell:cellBrick('#a5705a','#3e4a54'),wallPBR:[0.95,0],winPBR:[0.1,0.45],litP:0.34,litCols:WARM}),
  apt:buildFacade({detail:0.4,size:512,floors:16,bays:16,tw:5.6,th:6.4,wall:'#f1f0eb',depth:0.2,relief:2.4,
    cell:cellApt(),wallPBR:[0.88,0],winPBR:[0.12,0.3],litP:0.5,litCols:WARM}),
  retail:buildFacade({detail:0.35,size:512,floors:4,bays:10,tw:5.0,th:1.8,wall:'#c4bdae',depth:0.3,relief:2.6,
    cell:cellRetail(),wallPBR:[0.8,0],winPBR:[0.1,0.3],litP:0.75,litCols:WARM.concat(['#ffe9c0'])}),
  core:buildFacade({size:512,floors:8,bays:6,tw:3.6,th:3.36,wall:'#9da3a8',depth:0.15,relief:3.4,
    cell:function(g,gh,x,y,w,h){g.fillStyle='#9ea4a9';g.fillRect(x,y,w,h);gh.fillStyle=H(0.62);gh.fillRect(x,y,w,h);
      g.fillStyle='#8b9196';g.fillRect(x,y,2,h);g.fillRect(x,y,w,2);gh.fillStyle=H(0.45);gh.fillRect(x,y,2,h);gh.fillRect(x,y,w,2);
      const px=x+w*0.38,py=y+h*0.1,pw=w*0.24,ph=h*0.78;g.fillStyle='#3d464e';g.fillRect(px,py,pw,ph);gh.fillStyle=H(0.3);gh.fillRect(px,py,pw,ph);return [px,py,pw,ph];},
    wallPBR:[0.55,0.35],winPBR:[0.05,0.6],litP:0.18,litCols:WARM}),
  tower:buildFacade({size:1024,floors:8,bays:12,tw:3.6,th:3.36,wall:'#aebac4',depth:0.3,relief:2.2,
    cell:cellCurtain('#89a3b8','#5d7487','#334049','#c2ccd4'),wallPBR:[0.45,0.6],winPBR:[0.04,0.6],litP:0.4,litCols:COOL.concat(WARM)})
};
function noiseTex(size,base,amp,n){const [c,g]=makeCanvas(size);g.fillStyle=base;g.fillRect(0,0,size,size);
  for(let i=0;i<n;i++){const x=R()*size,y=R()*size,r=rand(1,size/14),v=R()<0.5?0:255;g.fillStyle='rgba('+v+','+v+','+v+','+(amp*R())+')';
    for(const dx of [-size,0,size])for(const dy of [-size,0,size]){g.beginPath();g.arc(x+dx,y+dy,r,0,TAU);g.fill();}}
  return tex(c,true);}
function waterNormalTex(){const s=256,[c,g]=makeCanvas(s),img=g.createImageData(s,s);
  const waves=[];for(let i=0;i<9;i++)waves.push({kx:Math.round(rand(-6,6)),ky:Math.round(rand(1,8)),a:rand(0.4,1)/(1+i*0.4),p:rand(0,TAU)});
  const hf=(x,y)=>waves.reduce((acc,w)=>acc+w.a*Math.sin(TAU*(w.kx*x+w.ky*y)/s+w.p),0);
  for(let y=0;y<s;y++)for(let x=0;x<s;x++){const dx=hf(x+1,y)-hf(x-1,y),dy=hf(x,y+1)-hf(x,y-1),nx=-dx*0.9,ny=-dy*0.9,nz=1,l=Math.hypot(nx,ny,nz),i=(y*s+x)*4;
    img.data[i]=(nx/l*0.5+0.5)*255;img.data[i+1]=(ny/l*0.5+0.5)*255;img.data[i+2]=(nz/l*0.5+0.5)*255;img.data[i+3]=255;}
  g.putImageData(img,0,0);return tex(c,false);}
function cloudTex(seed){const s=256,[c,g]=makeCanvas(s),r2=rng(seed);
  for(let i=0;i<46;i++){const a=r2()*TAU,d=Math.pow(r2(),0.7)*0.32,x=s/2+Math.cos(a)*d*s*1.1,y=s/2+Math.sin(a)*d*s*0.45+(r2()-0.5)*10,r=(0.1+r2()*0.16)*s*(1-d);
    const gr=g.createRadialGradient(x,y,0,x,y,r);gr.addColorStop(0,'rgba(255,255,255,0.42)');gr.addColorStop(0.6,'rgba(255,255,255,0.16)');gr.addColorStop(1,'rgba(255,255,255,0)');
    g.fillStyle=gr;g.beginPath();g.arc(x,y,r,0,TAU);g.fill();}
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;}
function dotTexture(){const [c,g]=makeCanvas(64),gr=g.createRadialGradient(32,32,0,32,32,32);
  gr.addColorStop(0,'rgba(255,255,255,1)');gr.addColorStop(0.3,'rgba(255,255,255,.65)');gr.addColorStop(1,'rgba(255,255,255,0)');g.fillStyle=gr;g.fillRect(0,0,64,64);return new THREE.CanvasTexture(c);}
const DOT=dotTexture();
const GROUND_NOISE=noiseTex(256,'#e6e6e6',0.14,500),GRASS_NOISE=noiseTex(256,'#dedede',0.22,700),WATER_N=waterNormalTex();
WATER_N.repeat.set(3,220);


/* ===================== Physical surface textures ===================== */
function surfaceSet(size,paint){
  const [ca,ga]=makeCanvas(size),[ch,gh]=makeCanvas(size),[cr,gr]=makeCanvas(size);
  const A=ga.createImageData(size,size),Hh=gh.createImageData(size,size),Rr=gr.createImageData(size,size);
  paint(A.data,Hh.data,Rr.data,size);
  ga.putImageData(A,0,0);gh.putImageData(Hh,0,0);gr.putImageData(Rr,0,0);
  return {map:tex(ca,true),nrm:heightToNormal(ch,3.2),rough:tex(cr,false)};
}
// fair-faced concrete: fine aggregate, air pores, formwork panel joints, tie holes and rain streaks
const CONCRETE=surfaceSet(1024,(A,Hd,Rd,S)=>{
  const holes=[];for(let y=128;y<S;y+=256)for(let x=128;x<S;x+=256)holes.push([x,y]);
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){
    const i=(y*S+x)*4,u=x/S*8,v=y/S*8;
    let n=fbm(NOISE,u,v,5)*0.6+fbm(NOISE2,u*6,v*6,3)*0.4;
    let h=0.55+(n-0.5)*0.25;
    let c=0.70+(n-0.5)*0.22;
    const g=((x*7919+y*104729)%997)/997;if(g>0.985){c-=0.18;h-=0.25;}else if(g<0.02){c+=0.06;}
    if(x%256<2||y%256<2){c-=0.08;h-=0.18;}
    let streak=0;for(const [hx,hy] of holes){const dx=x-hx,dy=y-hy;
      if(dx*dx+dy*dy<30){c-=0.3;h-=0.4;}
      if(dy>0&&dy<200&&Math.abs(dx)<6)streak=Math.max(streak,(1-dy/200)*(1-Math.abs(dx)/6)*0.12);}
    c-=streak;
    const r=Math.round(clamp(c*0.99,0,1)*255),gg=Math.round(clamp(c*0.98,0,1)*255),b=Math.round(clamp(c*0.95,0,1)*255);
    A[i]=r;A[i+1]=gg;A[i+2]=b;A[i+3]=255;
    const hv=Math.round(clamp(h,0,1)*255);Hd[i]=Hd[i+1]=Hd[i+2]=hv;Hd[i+3]=255;
    const ro=Math.round(clamp(0.82+(n-0.5)*0.3+streak,0,1)*255);Rd[i]=0;Rd[i+1]=ro;Rd[i+2]=0;Rd[i+3]=255;
  }});
// asphalt: dark binder, bright aggregate, patched and worn areas
const ASPHALT=surfaceSet(512,(A,Hd,Rd,S)=>{
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){
    const i=(y*S+x)*4,u=x/S*6,v=y/S*6,n=fbm(NOISE,u+30,v+30,4),p=fbm(NOISE2,u*1.7,v*1.7,3);
    // patchier where it has been resurfaced, but a gradient rather than a
    // step — the step read as camouflage at road scale
    let c=0.21+(n-0.5)*0.08+(p-0.5)*0.028;
    const g=hash2(x,y);let h=0.5+(n-0.5)*0.2;
    if(g>0.93){c+=0.1*((g-0.93)/0.07);h+=0.07;}
    const cv=Math.round(clamp(c,0,1)*255);A[i]=cv;A[i+1]=cv;A[i+2]=Math.round(cv*1.03);A[i+3]=255;
    const hv=Math.round(clamp(h,0,1)*255);Hd[i]=Hd[i+1]=Hd[i+2]=hv;Hd[i+3]=255;
    Rd[i]=0;Rd[i+1]=Math.round(clamp(0.9-(g>0.93?0.15:0),0,1)*255);Rd[i+2]=0;Rd[i+3]=255;
  }});
CONCRETE.map.repeat.set(1,1);
// lawn: fbm clumps + blade speckle, no repeating blobs
const LAWN=surfaceSet(512,(A,Hd,Rd,S)=>{
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){
    const i=(y*S+x)*4,u=x/S*8,v=y/S*8,n=fbm(NOISE,u+50,v+50,5),m=fbm(NOISE2,u*4,v*4,2);
    const sp=hash2(x+17,y+43);
    let g=0.55+(n-0.5)*0.35+(m-0.5)*0.15+(sp>0.8?0.08:sp<0.12?-0.1:0);
    A[i]=Math.round(clamp(g*0.82,0,1)*255);A[i+1]=Math.round(clamp(g*0.92,0,1)*255);A[i+2]=Math.round(clamp(g*0.62,0,1)*255);A[i+3]=255;
    const hv=Math.round(clamp(0.5+(m-0.5)*0.6+(sp-0.5)*0.3,0,1)*255);Hd[i]=Hd[i+1]=Hd[i+2]=hv;Hd[i+3]=255;
    Rd[i]=0;Rd[i+1]=235;Rd[i+2]=0;Rd[i+3]=255;}});
// granite pavers: staggered 600x300 slabs, sawn joints, per-slab tone
const PAVERS=surfaceSet(512,(A,Hd,Rd,S)=>{
  const tw=64,th=32;
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){
    const i=(y*S+x)*4,row=Math.floor(y/th),off=(row%2)*tw/2,cx=Math.floor((x+off)/tw),lx=(x+off)%tw,ly=y%th;
    const seed=((cx*73856093)^(row*19349663))>>>0,tone=(seed%1000)/1000;
    const n=fbm(NOISE,x/S*24,y/S*24,3),joint=lx<2||ly<2;
    let c=0.72+(tone-0.5)*0.08+(n-0.5)*0.12;if(joint)c-=0.22;
    const sp=hash2(x+91,y+7);if(sp>0.95)c-=0.05;
    const cv=clamp(c,0,1);A[i]=Math.round(cv*255);A[i+1]=Math.round(cv*0.985*255);A[i+2]=Math.round(cv*0.95*255);A[i+3]=255;
    const hv=Math.round(clamp(joint?0.25:0.6+(n-0.5)*0.1,0,1)*255);Hd[i]=Hd[i+1]=Hd[i+2]=hv;Hd[i+3]=255;
    Rd[i]=0;Rd[i+1]=Math.round((joint?0.95:0.7+(n-0.5)*0.2)*255);Rd[i+2]=0;Rd[i+3]=255;}});
LAWN.map.repeat.set(8,8);LAWN.nrm.repeat.set(8,8);LAWN.rough.repeat.set(8,8);
[PAVERS.map,PAVERS.nrm,PAVERS.rough].forEach(t=>t.repeat.set(7,7));


/* ===================== Materials ===================== */
/*
  World-projected facade mapping: window size and floor height stay true on every building,
  plus contact shading at the base and parallax interiors seen through the glass.
*/
// facades live in materials/facade.js now — the GLSL chunk surgery this used
// to do is TSL node assignments there. CONCRETE is the grain broken into solid wall.
function facadeMat(F,extra){
  return createFacadeMaterial(F,extra||{},{detailMap:CONCRETE.map});
}
const std=o=>new THREE.MeshStandardMaterial(o);
const M={
  tower:facadeMat(FACADES.tower),
  core:facadeMat(FACADES.core),
  curtainCool:facadeMat(FACADES.curtainCool),
  curtainCoolR:facadeMat(FACADES.curtainCool,{radial:true}),
  curtainWarm:facadeMat(FACADES.curtainWarm),
  precast:facadeMat(FACADES.precast),
  brick:facadeMat(FACADES.brick),
  apt:facadeMat(FACADES.apt),
  retail:facadeMat(FACADES.retail),
  roof:std({color:0xb0ada5,roughness:0.95}),
  parapet:std({color:0xc2bfb6,roughness:0.9}),
  mech:std({color:0x9ea2a3,roughness:0.7,metalness:0.3}),
  tile:std({color:0xffffff,roughness:0.8}),
  terrace:std({color:0x7c8e72,roughness:0.95}),
  garden:std({color:0xa3aca6,emissive:0xffc98a,emissiveIntensity:0,roughness:0.6}),
  concrete:std({color:0xd3d4cf,roughness:0.85}),
  metal:std({color:0xdfe4e8,metalness:0.9,roughness:0.25}),
  fin:std({color:0xb4bcc3,emissive:0xcfe6ff,emissiveIntensity:0,metalness:0.7,roughness:0.3}),
  water:std({color:0x2f4f63,metalness:0.9,roughness:0.08,normalMap:WATER_N,normalScale:new THREE.Vector2(0.35,0.35)}),
  pool:std({color:0x2f4f63,metalness:0.9,roughness:0.06}),
  road:std({color:0x45494d,emissive:0x50443a,emissiveIntensity:0,roughness:0.92}),
  marking:std({color:0xe9e9e4,roughness:0.8}),
  yellow:std({color:0xd9a93a,roughness:0.8}),
  sidewalk:std({color:0xcac5ba,roughness:0.95}),
  grass:std({color:0x6c8c55,roughness:1,map:GRASS_NOISE}),
  paving:std({color:0xdcd6c8,roughness:0.9,map:GROUND_NOISE}),
  ground:std({color:0xb5b2a8,roughness:1,map:GROUND_NOISE}),
  country:std({color:0xffffff,roughness:1}),
  hills:std({color:0x5b6b4c,roughness:1}),
  tree:std({color:0xffffff,roughness:1,flatShading:true}),
  car:std({color:0xffffff,roughness:0.35,metalness:0.4}),
  doorGlass:std({color:0x243038,metalness:0.6,roughness:0.12,emissive:0xffd6a0,emissiveIntensity:0}),
  canopy:std({color:0xb9bdc0,metalness:0.4,roughness:0.5}),
  stone:std({color:0xcfc9bc,roughness:0.9}),
  concreteFlat:std({color:0xd3d4cf,roughness:0.85,flatShading:true}),
  lantern:new THREE.MeshBasicMaterial({color:0xcfe6ff,transparent:true,opacity:0.1,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending})
};
Object.values(M).forEach(m=>{if(m.color)m.color.convertSRGBToLinear();if(m.emissive)m.emissive.convertSRGBToLinear();});
function concreteify(m,scale){m.map=CONCRETE.map;m.normalMap=CONCRETE.nrm;m.roughnessMap=CONCRETE.rough;m.roughness=1;m.normalScale=new THREE.Vector2(0.8,0.8);m.needsUpdate=true;}
[M.concrete,M.concreteFlat,M.stone].forEach(m=>concreteify(m));
Object.assign(M.grass,{map:LAWN.map,normalMap:LAWN.nrm,roughnessMap:LAWN.rough,roughness:1});M.grass.color.copy(lin('#98a386'));M.grass.needsUpdate=true;
[M.paving,M.ground].forEach(m=>{Object.assign(m,{map:PAVERS.map,normalMap:PAVERS.nrm,roughnessMap:PAVERS.rough,roughness:1,normalScale:new THREE.Vector2(0.7,0.7)});m.needsUpdate=true;});
M.paving.color.copy(lin('#f2eee6'));M.ground.color.copy(lin('#d2cec4'));
M.road.map=ASPHALT.map;M.road.normalMap=ASPHALT.nrm;M.road.roughnessMap=ASPHALT.rough;M.road.roughness=1;M.road.color.set(0xffffff);M.road.normalScale=new THREE.Vector2(0.6,0.6);M.road.needsUpdate=true;

// Real scanned materials (optional): list CC0 maps in textures/manifest.json (see textures/README.md).
(function(){
  if(!/^https?:$/.test(location.protocol)||!window.fetch)return;
  fetch('textures/manifest.json').then(r=>r.ok?r.json():null).then(man=>{
    if(!man)return;
    const L=new THREE.TextureLoader(),SLOTS={
      concrete:{mats:[M.concrete,M.concreteFlat,M.stone],rep:1},asphalt:{mats:[M.road],rep:1},
      grass:{mats:[M.grass],rep:8},paving:{mats:[M.paving,M.ground],rep:7}};
    Object.keys(SLOTS).forEach(k=>{const e=man[k];if(!e)return;const S2=SLOTS[k];
      [['color','map',true],['normal','normalMap',false],['roughness','roughnessMap',false]].forEach(([key,slot,srgb])=>{
        if(!e[key])return;L.load('textures/'+e[key],t=>{t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=ANISO;if(srgb)t.colorSpace=THREE.SRGBColorSpace;
          t.repeat.set(S2.rep,S2.rep);S2.mats.forEach(m=>{m[slot]=t;if(slot==='map')m.color.setScalar(1);m.needsUpdate=true;});});});});
  }).catch(()=>{});
})();
// Street furniture. The lenses are their own materials because they are the
// only part that changes: the pole is the same grey at noon and at midnight.
const SIGNAL_COLS={red:'#ff2d1f',amber:'#ffb01f',green:'#2fe06a'};
Object.assign(M,{
  lampPole:std({color:0x9aa1a7,metalness:0.2,roughness:0.5}),
  lampLens:std({color:0x2a2c2e,roughness:0.3,emissive:0xffc981,emissiveIntensity:0}),
  signalBody:std({color:0x4a4f54,metalness:0.2,roughness:0.6}),
  bollard:std({color:0x7e858b,metalness:0.25,roughness:0.55}),
  bench:std({color:0x7b6a55,roughness:0.75}),
  kerb:std({color:0xa8a49b,roughness:0.85}),
});
// These are declared after the sweep above, so they convert themselves.
['lampPole','lampLens','signalBody','bollard','bench','kerb'].forEach(k=>{
  if(M[k].color)M[k].color.convertSRGBToLinear();
  if(M[k].emissive)M[k].emissive.convertSRGBToLinear();
});
// two independent phases: what is green on the ring is red on the boulevard
const SIGNAL_LENS={};
[0,1].forEach(ph=>['red','amber','green'].forEach(k=>{
  SIGNAL_LENS[ph+k]=std({color:0x1b1d1f,roughness:0.35,
    emissive:new THREE.Color(SIGNAL_COLS[k]).convertSRGBToLinear(),emissiveIntensity:0});
}));

const FACADE_MATS=[M.tower,M.core,M.curtainCool,M.curtainCoolR,M.curtainWarm,M.precast,M.brick,M.apt,M.retail];
const REFLECTIVE=FACADE_MATS.concat([M.metal,M.fin,M.water,M.pool,M.car,M.mech,M.doorGlass,M.canopy]);
const WINDOW_MATS=[[M.doorGlass,0.9],[M.tower,1],[M.core,0.6],[M.curtainCool,0.85],[M.curtainCoolR,0.85],[M.curtainWarm,0.85],[M.precast,0.8],[M.brick,0.8],[M.apt,0.9],[M.retail,1.1]];

/* ===================== Atmosphere ===================== */
// sky lives in world/sky.js now; skyUni keeps the {value} shape the clock writes to
const _sky=createSky(3400);
const skyUni=_sky.uniforms,sky=_sky.mesh;
scene.add(sky);

const stars=(function(){const p=[];for(let i=0;i<1600;i++){const u=R()*TAU,v=0.04+R()*0.96,c=Math.sqrt(1-v*v);p.push(Math.cos(u)*c*3200,v*3200,Math.sin(u)*c*3200);}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));
  const m=new THREE.PointsMaterial({color:0xffffff,size:1.6,sizeAttenuation:false,transparent:true,opacity:0,depthWrite:false,depthTest:true,fog:false});
  const s=new THREE.Points(g,m);s.renderOrder=-9;s.frustumCulled=false;scene.add(s);return s;})();
const hemi=new THREE.HemisphereLight(0xffffff,0x000000,0.8);scene.add(hemi);
const sun=new THREE.DirectionalLight(0xffffff,2);
sun.castShadow=true;{const big=CAPS.maxTextureSize>=8192&&!window.matchMedia('(pointer: coarse)').matches;sun.shadow.mapSize.set(big?4096:2048,big?4096:2048);}
Object.assign(sun.shadow.camera,{left:-260,right:260,top:260,bottom:-260,near:1,far:2600});
sun.shadow.bias=-0.00025;sun.shadow.normalBias=0.04;
scene.add(sun);scene.add(sun.target);

function parsePreset(p){const o={};COLOR_KEYS.forEach(k=>o[k]=lin(p[k]));NUM_KEYS.forEach(k=>o[k]=p[k]);o.sunDir=new THREE.Vector3().fromArray(p.sunDir).normalize();return o;}
const PARSED={};Object.keys(PRESETS).forEach(k=>PARSED[k]=parsePreset(PRESETS[k]));
// pre-warms the equirect->cube material so the first HDRI swap does not hitch;
// it is async on the node renderer, and boot() can wait for it
const pmrem=new THREE.PMREMGenerator(renderer);await pmrem.compileEquirectangularShader();
function skyColorJS(d,P,out){
  const h=d.y,t=Math.pow(clamp(h,0,1),0.5);
  out.copy(P.skyHor).lerp(P.skyTop,t);out.lerp(P.skyGround,smooth(0,0.12,-h));
  const s=Math.max(d.dot(P.sunDir),0),k=(Math.pow(s,6)*0.25+Math.pow(s,48)*0.5)*P.sunGlow+smooth(0.9993,0.9997,s)*P.sunDisk*3;
  out.r+=P.sunCol.r*k;out.g+=P.sunCol.g*k;out.b+=P.sunCol.b*k;return out;
}
function bakeEnv(P){
  const W=256,HH=128,cv=document.createElement('canvas');cv.width=W;cv.height=HH;
  const ctx=cv.getContext('2d'),img=ctx.createImageData(W,HH),d=new THREE.Vector3(),c=new THREE.Color();
  for(let y=0;y<HH;y++)for(let x=0;x<W;x++){
    const lon=((x+0.5)/W-0.5)*TAU,lat=(0.5-(y+0.5)/HH)*Math.PI;
    d.set(Math.cos(lat)*Math.cos(lon),Math.sin(lat),Math.cos(lat)*Math.sin(lon));
    skyColorJS(d,P,c);c.r=Math.min(1,c.r);c.g=Math.min(1,c.g);c.b=Math.min(1,c.b);c.convertLinearToSRGB();
    const i=(y*W+x)*4;img.data[i]=c.r*255;img.data[i+1]=c.g*255;img.data[i+2]=c.b*255;img.data[i+3]=255;}
  ctx.putImageData(img,0,0);
  const t=new THREE.CanvasTexture(cv);t.mapping=THREE.EquirectangularReflectionMapping;t.colorSpace=THREE.SRGBColorSpace;
  const rt=pmrem.fromEquirectangular(t);t.dispose();return rt.texture;
}
const ENV={};
Object.keys(PARSED).forEach(k=>ENV[k]=bakeEnv(PARSED[k]));
// Poly Haven HDRIs (CC0). Until they arrive (or if they can't load, e.g. from file://) the procedural sky is used.
const HDR_FILES={day:'assets/hdri/city.exr',sunset:'assets/hdri/sunset.exr',night:'assets/hdri/night.exr'};
function loadHDR(key){
  if(!window.fetch)return;
  fetch(HDR_FILES[key]).then(r=>r.ok?r.arrayBuffer():Promise.reject(r.status)).then(buf=>{
    const L=new THREE.EXRLoader();L.setDataType(THREE.HalfFloatType);const d=L.parse(buf);
    const t=new THREE.DataTexture(d.data,d.width,d.height,d.format,THREE.HalfFloatType);
    t.colorSpace=THREE.LinearSRGBColorSpace;t.minFilter=t.magFilter=THREE.LinearFilter;t.generateMipmaps=false;t.flipY=false;t.needsUpdate=true;
    t.mapping=THREE.EquirectangularReflectionMapping;
    const rt=pmrem.fromEquirectangular(t);t.dispose();ENV[key]=rt.texture;
    if(envKey===key)setEnv(ENV[key]);
  }).catch(()=>{});
}
Object.keys(HDR_FILES).forEach(loadHDR);
function setEnv(t){REFLECTIVE.forEach(m=>{const first=!m.envMap;m.envMap=t;if(first)m.needsUpdate=true;});}

/* ===================== Master plan ===================== */
await step('도시 계획');
const rings=[];
ZB.slice(0,5).forEach(r=>rings.push({r:r,w:3.4,main:true}));
for(let i=0;i<5;i++){const a=ZB[i],b=ZB[i+1],n=Math.max(1,Math.round((b-a)/16));for(let j=1;j<n;j++)rings.push({r:a+(b-a)*j/n,w:1.6,main:false});}
rings.sort((p,q)=>p.r-q.r);
const zoneOf=r=>{for(let i=0;i<5;i++)if(r<ZB[i+1])return i;return 4;};
const spokes=ZB.slice(0,5).map((a,i)=>{const mid=(a+ZB[i+1])/2,n=Math.max(3,Math.round((TAU/3*mid)/18)),list=[];
  for(let k=0;k<3;k++)for(let j=0;j<n;j++)list.push({a:k*TAU/3+j*(TAU/3)/n,w:j===0?8:1.8,blvd:j===0});return list;});
const blocks=[];
for(let i=0;i<rings.length;i++){
  const A=rings[i],B=rings[i+1];
  const r0=A.r+A.w/2+0.7,r1=B?B.r-B.w/2-0.7:EDGE-3;if(r1-r0<3)continue;
  const rm=(r0+r1)/2,z=zoneOf(rm),sp=spokes[z];
  for(let j=0;j<sp.length;j++){
    const s0=sp[j],s1=sp[(j+1)%sp.length],a0=s0.a,a1=j+1<sp.length?s1.a:s1.a+TAU;
    blocks.push({r0:r0,r1:r1,rm:rm,z:z,a0:a0+(s0.w/2+0.7)/rm,a1:a1-(s1.w/2+0.7)/rm,blvd:s0.blvd||s1.blvd});
  }
}

/* ===================== Ground, roads, water, hills ===================== */
function flat(geo,mat,y,receive){const m=new THREE.Mesh(geo,mat);m.position.y=y;m.receiveShadow=receive!==false;scene.add(m);return m;}
{const [c,g]=makeCanvas(512);g.fillStyle='#7d8a62';g.fillRect(0,0,512,512);
 const FIELD=['#7d8a62','#8a9468','#6f7f55','#9a9a6a','#a39d72','#768a5a','#86905e','#6a7a50'];
 for(let y=0;y<512;){const h=rand(18,46);for(let x=0;x<512;){const w=rand(22,70);g.fillStyle=pick(FIELD);g.fillRect(x+1,y+1,w-2,h-2);x+=w;}y+=h;}
 const t=tex(c,true);t.repeat.set(60,60);M.country.map=t;M.country.needsUpdate=true;
 const pg=new THREE.PlaneGeometry(7000,7000);pg.rotateX(-Math.PI/2);flat(pg,M.country,0);
 const seg=560,rows=8,pos=[],idx=[];
 for(let r=0;r<rows;r++)for(let i=0;i<=seg;i++){
   const t2=i/seg*TAU,f=r/(rows-1),rad=1500+f*1400,prof=Math.sin(Math.PI*Math.min(1,f*1.2));
   const ridge=fbm(NOISE,Math.sin(t2)*3.5+40,Math.cos(t2)*3.5+40,5);
   const h=prof*(30+190*Math.pow(ridge,1.5))*(0.85+0.3*fbm(NOISE2,Math.sin(t2)*14,Math.cos(t2)*14,3));
   pos.push(Math.sin(t2)*rad,h,Math.cos(t2)*rad);}
 for(let r=0;r<rows-1;r++)for(let i=0;i<seg;i++){const a=r*(seg+1)+i,b=a+seg+1;idx.push(a,b,a+1,b,b+1,a+1);}
 const mg=new THREE.BufferGeometry();mg.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));mg.setIndex(idx);mg.computeVertexNormals();
 scene.add(new THREE.Mesh(mg,M.hills));}
{const g=new THREE.CircleGeometry(EDGE+4,160);g.rotateX(-Math.PI/2);flat(mergeGeos([g],0.12),M.ground,0.02);}
const riverG=new THREE.Group();riverG.position.set(Math.cos(RIVER.a)*RIVER.d,0,-Math.sin(RIVER.a)*RIVER.d);riverG.rotation.y=RIVER.a;scene.add(riverG);
{const bank=new THREE.Mesh(mergeGeos([new THREE.PlaneGeometry((RIVER.half+RIVER.bank)*2,3000).rotateX(-Math.PI/2)],0.1),M.grass);bank.position.y=0.06;bank.receiveShadow=true;riverG.add(bank);
 const w=new THREE.Mesh(new THREE.PlaneGeometry(RIVER.half*2,3000),M.water);w.rotation.x=-Math.PI/2;w.position.y=0.1;w.receiveShadow=true;riverG.add(w);}
const surfaces={};
{const road=[],mark=[],yel=[],walk=[],kerb=[];
 const dashRing=(r,period,len,w,out,gaps)=>{const n=Math.round(TAU*r/period);
   for(let i=0;i<n;i++){const a0=i/n*TAU,a1=a0+len/r;
     if(gaps&&gaps.some(([g0,g1])=>a1>g0&&a0<g1))continue;
     const g=new THREE.RingGeometry(r-w/2,r+w/2,1,1,a0,len/r);g.rotateX(-Math.PI/2);out.push(g);}};
 const dashRadial=(a,r0,r1,off,period,len,w,out,gaps)=>{
   for(let r=r0;r+len<r1;r+=period){
     if(gaps&&gaps.some(([g0,g1])=>r+len>g0&&r<g1))continue;
     out.push(radialStrip(a,r,r+len,w,off));}};

 // Where a road crosses a ring, the ring's footway and its painted lines have
 // to stop: they used to run straight across the carriageway and meet the
 // crossing road's own footway in mid-junction, leaving a raised kerb-height
 // hash of pavement in the middle of every intersection.
 const BLVD_HALF=4;
 const KERB=0.03;   // 30 cm of granite between carriageway and footway
 const ringGaps=g=>{
   const out=[];
   for(let k=0;k<3;k++){const a=k*TAU/3,h=BLVD_HALF/g.r;out.push([a-h,a+h]);}
   // A ring sitting on a zone boundary is met by the streets of the zone
   // inside it and the zone outside it. Taking only one zone's streets left
   // every second approach walled off behind an unbroken footway.
   for(let z=0;z<5;z++){
     if(g.r<ZB[z]-1e-6||g.r>ZB[z+1]+1e-6)continue;
     spokes[z].forEach(t=>{if(t.blvd)return;const h=(t.w/2)/g.r;out.push([t.a-h,t.a+h]);});
   }
   return out;
 };
 // ...and the other way round: a radial road stops at each ring it crosses.
 //
 // The two gap widths are deliberately different, and that asymmetry is the
 // point. A ring's footway stops at the crossing carriageway, so it carries on
 // over the corner; a radial road's footway stops at the ring's *whole*
 // corridor — carriageway, kerb and footway — so it does not arrive on top of
 // the piece already covering that corner. Breaking both at the carriageway
 // left the two footways overlapping in a patch at every junction, coplanar
 // and z-fighting, which read as a line running along the pavement.
 const WALK_W=0.55;
 const radialGaps=(r0,r1)=>rings.filter(g=>g.r>r0&&g.r<r1)
   .map(g=>[g.r-g.w/2-KERB-WALK_W,g.r+g.w/2+KERB+WALK_W]);

 rings.forEach(g=>{
   const gaps=ringGaps(g);
   road.push(flatRing(g.r-g.w/2,g.r+g.w/2));
   walk.push(...ringArcs(g.r-g.w/2-0.55,g.r-g.w/2-KERB,gaps),
             ...ringArcs(g.r+g.w/2+KERB,g.r+g.w/2+0.55,gaps));
   kerb.push(...ringArcs(g.r-g.w/2-KERB,g.r-g.w/2,gaps),
             ...ringArcs(g.r+g.w/2,g.r+g.w/2+KERB,gaps));
   if(g.main){
     yel.push(...ringArcs(g.r-0.09,g.r-0.03,gaps),...ringArcs(g.r+0.03,g.r+0.09,gaps));
     [-1,1].forEach(s2=>dashRing(g.r+s2*g.w/4,1.8,0.9,0.06,mark,gaps));
   } else {
     yel.push(...ringArcs(g.r-0.035,g.r+0.035,gaps));
   }});

 for(let z=0;z<5;z++)spokes[z].forEach(s2=>{if(s2.blvd)return;
   const gaps=radialGaps(ZB[z],ZB[z+1]);
   road.push(radialStrip(s2.a,ZB[z],ZB[z+1],s2.w));
   [-1,1].forEach(o=>{
     walk.push(...radialRuns(s2.a,ZB[z],ZB[z+1],0.55-KERB,o*(s2.w/2+0.27+KERB/2),gaps));
     kerb.push(...radialRuns(s2.a,ZB[z],ZB[z+1],KERB,o*(s2.w/2+KERB/2),gaps));});
   yel.push(...radialRuns(s2.a,ZB[z],ZB[z+1],0.07,0,gaps));});

 for(let k=0;k<3;k++){const a=k*TAU/3;
   const gaps=radialGaps(30,EDGE);
   road.push(radialStrip(a,30,EDGE,8));
   [-1,1].forEach(o=>{
     walk.push(...radialRuns(a,30,EDGE,0.6-KERB,o*(4.3+KERB/2),gaps));
     kerb.push(...radialRuns(a,30,EDGE,KERB,o*(4.0+KERB/2),gaps));
     dashRadial(a,30,EDGE,o*2.65,1.8,0.9,0.06,mark,gaps);
     mark.push(...radialRuns(a,30,EDGE,0.05,o*3.85,gaps));});}
 // Kept so the surface debug mode (press S) can recolour them one at a time.
 surfaces.road=flat(mergeGeos(road,0.8),M.road,ROAD_Y);
 surfaces.walk=flat(mergeGeos(walk),M.sidewalk,WALK_Y);
 if(kerb.length)surfaces.kerb=flat(mergeGeos(kerb),M.kerb,WALK_Y);
 surfaces.mark=flat(mergeGeos(mark),M.marking,MARK_Y);
 surfaces.yel=flat(mergeGeos(yel),M.yellow,MARK_Y);
 // Zebra crossings and stop bars where the boulevards meet the ring roads.
 // Sits a hair above the lane markings so the two never z-fight.
 {const cross=crossingGeometry({rings:rings});if(cross)surfaces.cross=flat(cross,M.marking,STREET_Y);}}

/* ===================== Chunked instancing ===================== */
const chunks=new Map();
function chunkOf(x,z){const r=Math.hypot(x,z);let b=0;while(r>BANDS[b+1])b++;const s=Math.floor((((Math.atan2(x,z)+TAU)%TAU))/(TAU/CH_SECT));return b*CH_SECT+s;}
function chunkGet(x,z){const id=chunkOf(x,z);let c=chunks.get(id);if(!c){c={id:id,items:{},minX:1e9,maxX:-1e9,minZ:1e9,maxZ:-1e9,maxY:0,trees:[]};chunks.set(id,c);}return c;}
function put(kind,x,z,y,th,sx,sy,sz,tint){
  const c=chunkGet(x,z);(c.items[kind]=c.items[kind]||[]).push({x:x,z:z,y:y,th:th,sx:sx,sy:sy,sz:sz,c:tint});
  const rr=Math.max(sx,sz)*0.75;
  c.minX=Math.min(c.minX,x-rr);c.maxX=Math.max(c.maxX,x+rr);c.minZ=Math.min(c.minZ,z-rr);c.maxZ=Math.max(c.maxZ,z+rr);c.maxY=Math.max(c.maxY,y+sy);
}
const beacons=[];
const TINT={
  curtainCool:['#e8eff5','#dbe6ee','#eff3f5','#d2dee7','#e4eaec','#dfe7e2'],
  curtainWarm:['#efe8dc','#e6dbc8','#f2ece0','#e0d3bc'],
  precast:['#efeade','#e6e0d2','#f2eee6','#ded8c9','#e9e4d6','#d8d2c4'],
  brick:['#b0907c','#a98a72','#c0a189','#9d8270','#b59a86','#8f7a6b'],
  apt:['#ffffff','#f5f3ee','#eef1f3','#f4efe6'],
  retail:['#ffffff','#f3efe6','#e9e4d8'],
  tile:['#6b5750','#4b5157','#5a6670','#54504a','#7a5a4a','#63666a','#4f5a52'],
  mech:['#a7abac','#9a9fa2','#b3b4b0'],
  parapet:['#d5d1c7','#c9c5bb','#dcd8ce']
};
const tint=k=>pick(TINT[k]||TINT.precast);
const frameOf=th=>({tx:Math.cos(th),tz:-Math.sin(th),nx:Math.sin(th),nz:Math.cos(th)});
function roofUnits(x,z,th,sx,sz,top,count,big){const f=frameOf(th);
  for(let i=0;i<count;i++){const w=big?rand(0.25,0.5)*Math.min(sx,sz):rand(0.3,0.9),d=big?w*rand(0.7,1.1):rand(0.3,0.8);
    const ox=(R()-0.5)*Math.max(0,sx-w-0.3),oz=(R()-0.5)*Math.max(0,sz-d-0.3);
    put('mech',x+f.tx*ox+f.nx*oz,z+f.tz*ox+f.nz*oz,top,th,w,rand(0.25,big?1.1:0.55),d,tint('mech'));}}
// One building: mass + retail plinth + parapet + rooftop plant (+ pitched roof for houses)
function building(rC,th,sx,sz,h,style,opt){
  h=Math.min(h,Math.min(sx,sz)*5.5+1.2);
  const [x,z]=polar(rC,th);
  if(riverD(x,z)<RIVER.half+RIVER.bank+Math.max(sx,sz)*0.5)return false;
  opt=opt||{};
  const y0=opt.retail?0.45:0;
  if(opt.retail)put('retail',x,z,0,th,sx+0.14,0.45,sz+0.14,tint('retail'));
  put(style,x,z,y0,th,sx,h-y0,sz,tint(style));
  if(opt.gable)put('gable',x,z,h,th,(sx>=sz?sx:sz)+0.16,rand(0.45,0.8),(sx>=sz?sz:sx)+0.16,tint('tile'));
  else{
    put('parapet',x,z,h,th,sx+0.12,0.14,sz+0.12,tint('parapet'));
    if(h>2.6)roofUnits(x,z,th,sx,sz,h+0.1,1+(R()<0.6?1:0)+(R()<0.3?1:0),false);
  }
  if(!opt.gable&&h>2&&Math.min(sx,sz)>1.5){
    const f=frameOf(th),dz=sz/2+(opt.retail?0.09:0.02),dw=Math.min(1.5,sx*0.42);
    put('door',x+f.nx*dz,z+f.nz*dz,0,th,dw,0.34,0.08,'#ffffff');
    put('canopy',x+f.nx*(dz+0.2),z+f.nz*(dz+0.2),0.36,th,dw+0.34,0.06,0.42,'#e7e4dc');
    if(R()<0.5){[-1,1].forEach(sd=>put('canopy',x+f.nx*(dz+0.16)+f.tx*sd*(dw/2+0.1),z+f.nz*(dz+0.16)+f.tz*sd*(dw/2+0.1),0,th,0.1,0.36,0.1,'#d9d5cc'));}
  }
  if(h>22)beacons.push(x,h+1,z);
  return true;
}
function towerMass(rC,th,sx,sz,h,podiumTop){
  const [x,z]=polar(rC,th);
  if(riverD(x,z)<RIVER.half+RIVER.bank+Math.max(sx,sz)*0.5)return;
  const r=R(),shape=r<0.55?'curtainCool':r<0.8?'octa':r<0.92?'round':'curtainWarm';
  const round=shape==='octa'||shape==='round';
  const w=round?Math.max(sx,sz):sx,d=round?w:sz;
  h=Math.min(h,Math.min(w,d)*7.5);
  const style=shape==='octa'?'octa':shape==='round'?'round':shape;
  put(style,x,z,podiumTop||0,th,w,h,d,tint(shape==='curtainWarm'?'curtainWarm':'curtainCool'));
  let top=(podiumTop||0)+h;
  if(R()<0.5){const hc=floorQ(rand(1.6,4.4)),k=rand(0.6,0.8);put(style,x,z,top,th,w*k,hc,d*k,tint('curtainCool'));top+=hc;roofUnits(x,z,th,w*k*0.7,d*k*0.7,top,1,true);}
  else{put('parapet',x,z,top,th,w+0.16,0.2,d+0.16,tint('parapet'));roofUnits(x,z,th,w*0.7,d*0.7,top+0.1,2,true);}
  if(top>22)beacons.push(x,top+1,z);
}
// Fractal parcelling: recursive binary splits of the block, alleys appearing at random depths
function subdivide(p,minSize,out,depth){
  const rm=(p.r0+p.r1)/2,D=p.r1-p.r0,Lt=rm*(p.a1-p.a0);
  if(D<0.8||Lt<0.8)return;
  if(depth>7||(D<minSize*1.8&&Lt<minSize*1.8)){out.push({rm:rm,th:(p.a0+p.a1)/2,sx:Lt,sz:D});return;}
  const t=rand(0.36,0.64),gap=R()<0.3?rand(0.2,0.6):0.06;
  if(D>=Lt){const m=p.r0+D*t;
    subdivide({r0:p.r0,r1:m-gap/2,a0:p.a0,a1:p.a1},minSize,out,depth+1);
    subdivide({r0:m+gap/2,r1:p.r1,a0:p.a0,a1:p.a1},minSize,out,depth+1);}
  else{const m=p.a0+(p.a1-p.a0)*t,ga=gap/rm;
    subdivide({r0:p.r0,r1:p.r1,a0:p.a0,a1:m-ga/2},minSize,out,depth+1);
    subdivide({r0:p.r0,r1:p.r1,a0:m+ga/2,a1:p.a1},minSize,out,depth+1);}
}
const trees=[];
const GREENS=['#4f7240','#5f8246','#46693c','#6c8a4b','#527a47','#5c7d41','#6f7f3f'];
function tree(x,z,s,cone){if(riverD(x,z)<RIVER.half+1)return;const t={x:x,z:z,s:s||rand(0.8,1.3),cone:cone===undefined?R()<0.22:cone};trees.push(t);chunkGet(x,z).trees.push(t);}
const grassGeos=[],pavingGeos=[];
function parkBlock(b,density){
  grassGeos.push(sectorGeo(b.r0,b.r1,b.a0,b.a1));
  const area=(b.r1-b.r0)*b.rm*(b.a1-b.a0),n=Math.round(area/30*density);
  for(let i=0;i<n;i++){const [x,z]=polar(rand(b.r0+0.8,b.r1-0.8),rand(b.a0+0.8/b.rm,b.a1-0.8/b.rm));tree(x,z);}
}
// fractal height field -> clustered sub-centres instead of one smooth cone
const heightField=(x,z)=>Math.pow(fbm(NOISE,x/210+11,z/210+7,4),1.5);
const grainField=(x,z)=>fbm(NOISE2,x/95+3,z/95+5,3);
const ZONE_BASE=[30,11,6.5,3.2,2];
function blockPotential(b){
  const [x,z]=polar(b.rm,(b.a0+b.a1)/2);
  const rf=1+0.75*Math.exp(-(b.rm-58)/95);
  return ZONE_BASE[b.z]*rf*(0.5+1.05*heightField(x,z))*(b.blvd?1.1:1);
}
function perimeterBlock(b,style,hBase){
  const span=b.a1-b.a0,D=b.r1-b.r0,d=Math.min(2.8,D*0.32);
  if(D<6||b.rm*span<6){const h=floorQ(rand(hBase*0.8,hBase*1.2));building(b.rm,(b.a0+b.a1)/2,b.rm*span-0.8,D-0.8,h,style,{retail:hBase>3});return;}
  const bands=[{r0:b.r1-d,r1:b.r1,a0:b.a0,a1:b.a1},{r0:b.r0,r1:b.r0+d,a0:b.a0,a1:b.a1},
    {r0:b.r0+d,r1:b.r1-d,a0:b.a0,a1:b.a0+(d/b.rm)},{r0:b.r0+d,r1:b.r1-d,a0:b.a1-(d/b.rm),a1:b.a1}];
  bands.forEach(band=>{const out=[];subdivide(band,2.6,out,4);
    out.forEach(p=>{const h=floorQ(rand(hBase*0.8,hBase*1.2)*(R()<0.1?1.35:1));
      building(p.rm,p.th,Math.max(0.9,p.sx-0.2),Math.max(0.9,p.sz-0.2),h,R()<0.35?'brick':style,{retail:hBase>3.2});});});
  const inner={r0:b.r0+d+0.4,r1:b.r1-d-0.4,a0:b.a0+(d+0.4)/b.rm,a1:b.a1-(d+0.4)/b.rm};
  if(inner.r1-inner.r0>1.5&&inner.a1>inner.a0){grassGeos.push(sectorGeo(inner.r0,inner.r1,inner.a0,inner.a1));
    for(let i=0;i<5;i++){const [x,z]=polar(rand(inner.r0,inner.r1),rand(inner.a0,inner.a1));tree(x,z,rand(0.7,1));}}
}
function towerBlock(b,pot){
  const span=b.a1-b.a0,D=b.r1-b.r0,Lt=b.rm*span,mid=(b.a0+b.a1)/2;
  const podH=floorQ(rand(2.2,4.6));
  building(b.rm,mid,Lt-1.2,D-1.2,podH,'precast',{retail:true});
  const out=[];subdivide({r0:b.r0+1,r1:b.r1-1,a0:b.a0+1/b.rm,a1:b.a1-1/b.rm},4.5,out,4);
  out.sort((p,q)=>q.sx*q.sz-p.sx*p.sz);
  const n=Math.min(out.length,Lt>26?3:Lt>14?2:1);
  for(let i=0;i<n;i++){const p=out[i];
    const fp=Math.max(3.2,Math.min(8,Math.min(p.sx,p.sz)*0.92));
    towerMass(p.rm,p.th,fp*rand(0.85,1.15),fp,floorQ(pot*rand(0.7,1.15)),podH);}
}
function fineGrain(b,hBase){
  const out=[];subdivide({r0:b.r0,r1:b.r1,a0:b.a0,a1:b.a1},2.4,out,3);
  out.forEach(p=>{
    if(R()<0.07){const [x,z]=polar(p.rm,p.th);grassGeos.push(sectorGeo(p.rm-p.sz/2,p.rm+p.sz/2,p.th-p.sx/2/p.rm,p.th+p.sx/2/p.rm));tree(x,z);return;}
    const h=floorQ(rand(hBase*0.7,hBase*1.25)*(R()<0.07?1.5:1));
    building(p.rm,p.th,Math.max(0.9,p.sx-rand(0.15,0.4)),Math.max(0.9,p.sz-rand(0.15,0.4)),h,R()<0.45?'brick':'precast',{retail:R()<0.75});});
}
function slabBlock(b){
  const span=b.a1-b.a0,D=b.r1-b.r0,rows=Math.max(1,Math.floor((D-1)/5.4));
  for(let r=0;r<rows;r++){const rC=b.r0+D*(r+0.5)/rows,L=rC*span,nS=L>26?2:1;
    for(let s=0;s<nS;s++){const len=Math.min(L/nS*0.82,12),h=floorQ(rand(6,9.6)),th=b.a0+span*(s+0.5)/nS;
      if(building(rC,th,len,1.6,h,'apt',{})){const [x,z]=polar(rC,th);put('mech',x,z,h+0.14,th,Math.min(2.2,len*0.22),0.5,1.1,tint('mech'));}}
    if(r<rows-1){const rg=rC+D/rows/2;grassGeos.push(sectorGeo(rg-1,rg+1,b.a0,b.a1));
      for(let t=0;t<4;t++){const [x,z]=polar(rg,rand(b.a0,b.a1));tree(x,z,rand(0.7,1));}}}
  if(R()<0.6){const th=(b.a0+b.a1)/2;building(b.rm,th,Math.min(6,b.rm*span*0.35),Math.min(3,D*0.4),1.2,'precast',{retail:true});}
}
function villaBlock(b,dens){
  const out=[];subdivide({r0:b.r0,r1:b.r1,a0:b.a0,a1:b.a1},3.4,out,4);
  out.forEach(p=>{
    if(R()>dens){const [x,z]=polar(p.rm,p.th);if(R()<0.6)tree(x,z);return;}
    const sx=Math.max(1.2,p.sx*rand(0.45,0.7)),sz=Math.max(1.2,p.sz*rand(0.45,0.7)),h=floorQ(rand(0.9,2.4));
    building(p.rm,p.th,sx,sz,h,R()<0.5?'brick':'precast',{gable:R()<0.6});
    const f=frameOf(p.th),[x,z]=polar(p.rm,p.th);
    if(R()<0.75)tree(x+f.tx*p.sx*0.3,z+f.tz*p.sx*0.3,rand(0.6,1));});
}
blocks.forEach(b=>{
  if(b.a1-b.a0<=0.001)return;
  const [cx,cz]=polar(b.rm,(b.a0+b.a1)/2);
  if(riverD(cx,cz)<RIVER.half+RIVER.bank+6){parkBlock(b,0.6);return;}
  const g=grainField(cx,cz);
  if(g>0.78||R()<[0.05,0.07,0.09,0.1,0.16][b.z]){parkBlock(b,1);return;}
  const pot=blockPotential(b);
  if(pot>17)towerBlock(b,pot);
  else if(pot>7.5)perimeterBlock(b,R()<0.5?'precast':'curtainWarm',Math.min(pot,12));
  else if(b.z>=2&&g<0.42&&pot>3.4)slabBlock(b);
  else if(pot>3)fineGrain(b,pot);
  else villaBlock(b,b.z>=4?0.5:0.8);
});

/* ===================== Central park & greenery ===================== */
{const g=new THREE.CircleGeometry(30,96);g.rotateX(-Math.PI/2);flat(mergeGeos([g],0.15),M.paving,0.12);
 flat(flatRing(18,20.5),M.pool,0.16);
 const outer=ZB[0]-3.4/2-0.7-0.55;
 grassGeos.push(sectorGeo(30,outer,0,TAU));
 pavingGeos.push(flatRing(42.3,43.7));
 for(let k=0;k<3;k++)pavingGeos.push(radialStrip(k*TAU/3+TAU/6,30,outer,1.4));
 const ghostXZ=GHOSTS.map(g2=>polar(g2.r,g2.th));
 for(let i=0;i<900&&trees.length<520;i++){
   const r=rand(31.5,outer-1),a=R()*TAU;if(Math.abs(r-43)<1.8)continue;
   let ok=true;
   for(let k=0;k<3;k++){const bl=k*TAU/3,pth=bl+TAU/6;
     if(Math.abs(Math.sin(a-bl))*r<5.5&&Math.cos(a-bl)>0)ok=false;
     if(Math.abs(Math.sin(a-pth))*r<1.8&&Math.cos(a-pth)>0)ok=false;}
   const [x,z]=polar(r,a);ghostXZ.forEach(gp=>{if(Math.hypot(x-gp[0],z-gp[1])<6)ok=false;});
   if(ok)tree(x,z);}}
{const radii=[30].concat(rings.map(r=>r.r)).concat([EDGE]),widths=[0].concat(rings.map(r=>r.w)).concat([0]);
 for(let k=0;k<3;k++){const a=k*TAU/3,sx=Math.sin(a),sz=Math.cos(a),tx=Math.cos(a),tz=-Math.sin(a);
  for(let i=0;i<radii.length-1;i++){
    const s=radii[i]+widths[i]/2+1.2,e=radii[i+1]-widths[i+1]/2-1.2;if(e-s<3)continue;
    grassGeos.push(radialStrip(a,s,e,2.6));
    for(let r=s+1;r<e;r+=3.2){tree(sx*r,sz*r,rand(0.8,1),false);[-4.9,4.9].forEach(o=>tree(sx*r+tx*o,sz*r+tz*o,rand(0.75,1),false));}
  }}}
{const n=[Math.cos(RIVER.a),-Math.sin(RIVER.a)],t=[Math.sin(RIVER.a),Math.cos(RIVER.a)];
 for(let s=-700;s<700;s+=3.4)[-1,1].forEach(side=>{if(R()<0.35)return;const off=side*(RIVER.half+rand(2,RIVER.bank-2));
  const x=n[0]*RIVER.d+t[0]*s+n[0]*off,z=n[1]*RIVER.d+t[1]*s+n[1]*off;if(Math.hypot(x,z)<EDGE+80)tree(x,z);});}
flat(mergeGeos(grassGeos,0.1),M.grass,0.08);
flat(mergeGeos(pavingGeos,0.15),M.paving,0.1);

/* ===================== Build chunk meshes ===================== */
await step('건물 배치');
const GEO={
  box:new THREE.BoxGeometry(1,1,1).translate(0,0.5,0),
  octa:new THREE.CylinderGeometry(0.5,0.5,1,8,1).rotateY(Math.PI/8).translate(0,0.5,0),
  round:new THREE.CylinderGeometry(0.5,0.5,1,24,1).translate(0,0.5,0),
  gable:(function(){const A=[-.5,0,-.5],B=[.5,0,-.5],C=[.5,0,.5],D=[-.5,0,.5],E=[-.5,1,0],F=[.5,1,0];
    const tri=[A,E,F,A,F,B,D,C,F,D,F,E,A,D,E,B,F,C],g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute([].concat.apply([],tri),3));g.computeVertexNormals();return g;})(),
  canopy:mergeGeos([new THREE.IcosahedronGeometry(0.72,0).translate(0,1.2,0),new THREE.IcosahedronGeometry(0.52,0).translate(0.34,0.95,0.18)]),
  cone:mergeGeos([new THREE.ConeGeometry(0.6,2.0,7).translate(0,1.2,0)]),
  lamp:lampGeometry(),
  lampLens:lampLensGeometry(),
  signal:signalGeometry(),
  sigLens0:signalLensGeometry(0),
  sigLens1:signalLensGeometry(1),
  sigLens2:signalLensGeometry(2),
  bollard:bollardGeometry(),
  bench:benchGeometry()
};
const six=m=>[m,m,M.roof,M.roof,m,m];
const KIND={
  curtainCool:{geo:GEO.box,mat:six(M.curtainCool)},
  curtainWarm:{geo:GEO.box,mat:six(M.curtainWarm)},
  precast:{geo:GEO.box,mat:six(M.precast)},
  brick:{geo:GEO.box,mat:six(M.brick)},
  apt:{geo:GEO.box,mat:six(M.apt)},
  retail:{geo:GEO.box,mat:six(M.retail)},
  octa:{geo:GEO.octa,mat:[M.curtainCool,M.roof,M.roof]},
  // radial facades need each instance's own X scale to keep arc-length UVs
  // even, which means a per-chunk geometry to hang the attribute on
  round:{geo:GEO.round,mat:[M.curtainCoolR,M.roof,M.roof],perInstanceScale:true},
  parapet:{geo:GEO.box,mat:M.parapet,detail:true},
  door:{geo:GEO.box,mat:M.doorGlass,detail:true},
  canopy:{geo:GEO.box,mat:M.canopy,detail:true},
  mech:{geo:GEO.box,mat:M.mech,detail:true},
  gable:{geo:GEO.gable,mat:M.tile},

  // Street furniture. All `detail`, so it draws only inside the LOD band and
  // the existing point cloud carries the city beyond it.
  lamp:{geo:GEO.lamp,mat:M.lampPole,detail:true},
  lampLens:{geo:GEO.lampLens,mat:M.lampLens,detail:true},
  signal:{geo:GEO.signal,mat:M.signalBody,detail:true},
  bollard:{geo:GEO.bollard,mat:M.bollard,detail:true},
  bench:{geo:GEO.bench,mat:M.bench,detail:true},
  sig0red:{geo:GEO.sigLens0,mat:SIGNAL_LENS['0red'],detail:true},
  sig0amber:{geo:GEO.sigLens1,mat:SIGNAL_LENS['0amber'],detail:true},
  sig0green:{geo:GEO.sigLens2,mat:SIGNAL_LENS['0green'],detail:true},
  sig1red:{geo:GEO.sigLens0,mat:SIGNAL_LENS['1red'],detail:true},
  sig1amber:{geo:GEO.sigLens1,mat:SIGNAL_LENS['1amber'],detail:true},
  sig1green:{geo:GEO.sigLens2,mat:SIGNAL_LENS['1green'],detail:true}
};
// Street furniture goes through the same chunking as the buildings, so it is
// culled and LOD'd by machinery that already exists.
{
  const plan=planStreetFurniture({rings:rings,spokes:spokes});
  plan.lamps.forEach(l=>{put('lamp',l.x,l.z,WALK_Y,l.th,1,1,1);put('lampLens',l.x,l.z,WALK_Y,l.th,1,1,1);});
  plan.signals.forEach(g=>{
    put('signal',g.x,g.z,WALK_Y,g.th,1,1,1);
    const ph=g.phase?1:0;
    put('sig'+ph+'red',g.x,g.z,WALK_Y,g.th,1,1,1);
    put('sig'+ph+'amber',g.x,g.z,WALK_Y,g.th,1,1,1);
    put('sig'+ph+'green',g.x,g.z,WALK_Y,g.th,1,1,1);
  });
  plan.bollards.forEach(b=>put('bollard',b.x,b.z,WALK_Y,b.th,1,1,1));
  plan.benches.forEach(b=>put('bench',b.x,b.z,WALK_Y,b.th,1,1,1));
  console.info('가로 시설물: 가로등 '+plan.lamps.length+' · 신호등 '+plan.signals.length+' · 볼라드 '+plan.bollards.length+' · 벤치 '+plan.benches.length);
}

const chunkList=[];
const _m=new THREE.Matrix4(),_q=new THREE.Quaternion(),_up=new THREE.Vector3(0,1,0),_p=new THREE.Vector3(),_s=new THREE.Vector3(),_c=new THREE.Color();
let instanceCount=0;
chunks.forEach(c=>{
  const group=new THREE.Group();group.matrixAutoUpdate=false;scene.add(group);
  const detail=[];
  Object.keys(c.items).forEach(kind=>{
    const L=c.items[kind],K=KIND[kind];if(!K)return;
    // instanceMatrix lives on the mesh, but a custom instanced attribute has to
    // live on the geometry — so a kind that needs one cannot share geometry
    const geo=K.perInstanceScale?K.geo.clone():K.geo;
    if(K.perInstanceScale){
      const sc=new Float32Array(L.length);
      L.forEach((b,i)=>{sc[i]=b.sx;});
      geo.setAttribute('iscale',new THREE.InstancedBufferAttribute(sc,1));
    }
    const im=new THREE.InstancedMesh(geo,K.mat,L.length);im.frustumCulled=false;instanceCount+=L.length;
    L.forEach((b,i)=>{_q.setFromAxisAngle(_up,b.th);_m.compose(_p.set(b.x,b.y,b.z),_q,_s.set(b.sx,b.sy,b.sz));im.setMatrixAt(i,_m);
      im.setColorAt(i,_c.set(b.c||'#ffffff').convertSRGBToLinear());});
    im.castShadow=true;im.receiveShadow=true;group.add(im);
    if(K.detail)detail.push(im);
  });
  if(c.trees.length){
    [[GEO.canopy,c.trees.filter(t=>!t.cone)],[GEO.cone,c.trees.filter(t=>t.cone)]].forEach(([g,list])=>{
      if(!list.length)return;const im=new THREE.InstancedMesh(g,M.tree,list.length);im.frustumCulled=false;instanceCount+=list.length;
      list.forEach((t,i)=>{_q.setFromAxisAngle(_up,R()*TAU);_m.compose(_p.set(t.x,0.1,t.z),_q,_s.set(t.s,t.s*rand(0.9,1.25),t.s));im.setMatrixAt(i,_m);
        im.setColorAt(i,_c.set(pick(GREENS)).offsetHSL(0,rand(-0.04,0.04),rand(-0.04,0.04)).convertSRGBToLinear());});
      im.castShadow=true;im.receiveShadow=true;group.add(im);detail.push(im);});
  }
  const cx=(c.minX+c.maxX)/2,cz=(c.minZ+c.maxZ)/2;
  const radius=Math.max(1,Math.hypot(c.maxX-cx,c.maxZ-cz,c.maxY*0.5)+2);
  chunkList.push({group:group,detail:detail,sphere:new THREE.Sphere(new THREE.Vector3(cx,c.maxY*0.5,cz),radius)});
});

/* ===================== The tower ===================== */
await step('타워');
const tower=new THREE.Group();scene.add(tower);
const wingDir=k=>k*TAU/3;
function wingLen(i,k){let c=0;for(let j=1;j<=i;j++)if(j%3===k)c++;return 10-1.85*c;}
function part(geo,mat,x,y,z,ry,cast){const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);m.rotation.y=ry||0;m.castShadow=cast!==false;m.receiveShadow=true;tower.add(m);return m;}
const rotXZ=(lx,lz,a)=>[lx*Math.cos(a)+lz*Math.sin(a),-lx*Math.sin(a)+lz*Math.cos(a)];
const wingR=W=>Math.min(1.5,W*0.34);
function wingShape(W,L,grow){const g=grow||0,r=wingR(W)+g,x0=-W/2-g,x1=W/2+g,y1=-L-g,s=new THREE.Shape();
  s.moveTo(x0,0);s.lineTo(x0,y1+r);s.absarc(x0+r,y1+r,r,Math.PI,1.5*Math.PI,false);s.lineTo(x1-r,y1);s.absarc(x1-r,y1+r,r,1.5*Math.PI,2*Math.PI,false);s.lineTo(x1,0);s.lineTo(x0,0);return s;}
function wingGeo(W,L,h){const g=new THREE.ExtrudeGeometry(wingShape(W,L),{depth:h,bevelEnabled:false,curveSegments:8});g.rotateX(-Math.PI/2);return g;}
// ring around the wing outline (slab edges, balustrades)
function wingRing(W,L,grow,depth){const outer=wingShape(W,L,grow),hole=wingShape(W,L,-0.02);outer.holes.push(new THREE.Path(hole.getPoints(8).reverse()));
  const g=new THREE.ExtrudeGeometry(outer,{depth:depth,bevelEnabled:false,curveSegments:8});g.rotateX(-Math.PI/2);return g;}
// sample the outline: shape coords -> points with outward normals
function wingOutline(W,L,step){const r=wingR(W),x0=-W/2,x1=W/2,y1=-L,pts=[];
  const seg=(ax,ay,bx,by,nx,ny)=>{const n=Math.max(1,Math.floor(Math.hypot(bx-ax,by-ay)/step));for(let i=0;i<n;i++){const t=(i+0.5)/n;pts.push([ax+(bx-ax)*t,ay+(by-ay)*t,nx,ny]);}};
  const arc=(cx,cy,a0,a1)=>{const n=Math.max(2,Math.floor(Math.abs(a1-a0)*r/step));for(let i=0;i<=n;i++){const a=a0+(a1-a0)*i/n;pts.push([cx+Math.cos(a)*r,cy+Math.sin(a)*r,Math.cos(a),Math.sin(a)]);}};
  seg(x0,0,x0,y1+r,-1,0);arc(x0+r,y1+r,Math.PI,1.5*Math.PI);seg(x0+r,y1,x1-r,y1,0,-1);arc(x1-r,y1+r,1.5*Math.PI,2*Math.PI);seg(x1,y1+r,x1,0,1,0);
  return pts;}
// shape (sx,sy) of wing k -> world xz, and its outward normal
function wingToWorld(sx,sy,a){return [sx*Math.cos(a)-sy*Math.sin(a),-sx*Math.sin(a)-sy*Math.cos(a)];}
const towerBeacons=[];
{const T=TOWER,colGeo=new THREE.CylinderGeometry(0.32,0.32,T.gap,8);
 part(new THREE.CylinderGeometry(3.6,3.6,T.y0,6),[M.tower,M.roof,M.roof],0,T.y0/2,0);
 // plinth, steps, glass lobby, buttresses, entrance portals
 for(let i=0;i<3;i++){const st=part(new THREE.CylinderGeometry(16.4-i*0.6,16.4-i*0.6,0.18,72),M.stone,0,0.09+i*0.18,0,0,false);st.receiveShadow=true;}
 part(new THREE.CylinderGeometry(14.8,14.8,0.3,72),M.paving,0,0.68,0,0,false);
 part(new THREE.CylinderGeometry(11.5,11.9,3.6,6,1,true),[M.tower],0,2.5,0,Math.PI/6);
 part(new THREE.CylinderGeometry(11.95,11.95,0.22,6),[M.canopy,M.canopy,M.canopy],0,4.28,0,Math.PI/6);
 for(let k=0;k<3;k++){
   const a=wingDir(k),sn=Math.sin(a),cs=Math.cos(a);
   const py=part(new THREE.CylinderGeometry(1.15,2.15,T.y0,4),M.concreteFlat,sn*8.6,T.y0/2,cs*8.6,a+Math.PI/4);
   py.scale.set(1.5,1,0.95);
   [a+Math.PI/3,a-Math.PI/3].forEach(ang=>{
     const s2=Math.sin(ang),c2=Math.cos(ang),tx=Math.cos(ang),tz=-Math.sin(ang);
     part(new THREE.BoxGeometry(7.6,0.32,3.4),M.canopy,s2*12.6,3.05,c2*12.6,ang,true);
     part(new THREE.BoxGeometry(6.2,2.7,0.3),M.doorGlass,s2*11.45,1.55,c2*11.45,ang,false);
     part(new THREE.BoxGeometry(6.6,0.5,0.34),M.canopy,s2*11.5,3.05,c2*11.5,ang,false);
     [-3.1,3.1].forEach(o=>part(new THREE.CylinderGeometry(0.24,0.24,2.9,10),M.metal,s2*13.9+tx*o,1.45,c2*13.9+tz*o,0));
     for(let st=0;st<3;st++)part(new THREE.BoxGeometry(8,0.18,0.62),M.stone,s2*(15.1+st*0.6),0.62-st*0.18,c2*(15.1+st*0.6),ang,false);
     for(let bo=-2;bo<=2;bo++)if(bo)part(new THREE.CylinderGeometry(0.1,0.1,0.55,8),M.metal,s2*16.9+tx*bo*1.5,0.3,c2*16.9+tz*bo*1.5,0,false);
   });
 }
 for(let i=0;i<T.nseg;i++){
   const yb=T.y0+i*T.segH,last=i===T.nseg-1,hB=last?T.segH:T.segH-T.gap,W=4.6-0.17*i;
   const rB=3.6-0.1*i,rT=3.6-0.1*(i+1),rG=rB+(rT-rB)*(hB/T.segH);
   part(new THREE.CylinderGeometry(rG,rB,hB,6),[M.core,M.roof,M.roof],0,yb+hB/2,0);
   if(!last)part(new THREE.CylinderGeometry(rT,rG,T.gap,6),[M.garden,M.roof,M.roof],0,yb+hB+T.gap/2,0,0,false);
   for(let k=0;k<3;k++){
     const L=wingLen(i,k),a=wingDir(k),rr=Math.min(1.5,W*0.34);
     part(wingGeo(W,L,hB),[M.terrace,M.tower],0,yb,0,a);
     [-1,1].forEach(s=>{
       const f=rotXZ(s*(W/2-rr*0.29),L-rr*0.29,a);part(new THREE.BoxGeometry(0.16,hB,0.16),M.fin,f[0],yb+hB/2,f[1],a+s*Math.PI/4,false);
       if(!last){const Lc=Math.min(L,wingLen(i+1,k)),Wc=Math.min(W,4.6-0.17*(i+1)),p=rotXZ(s*(Wc/2-0.45),Lc-0.6,a);part(colGeo,M.concrete,p[0],yb+hB+T.gap/2,p[1]);}});
     if(i>=5){const p=rotXZ(0,L,a);towerBeacons.push(p[0],yb+hB+0.2,p[1]);}
   }}
 const CB=T.y0+T.nseg*T.segH,CT=T.top,RC=3.3,apex=new THREE.Vector3(0,CT,0);
 const hexAt=(y,i)=>{const r=RC*(1-(y-CB)/(CT-CB)),a=i*Math.PI/3+Math.PI/6;return new THREE.Vector3(Math.sin(a)*r,y,Math.cos(a)*r);};
 const strut=(a,b,r)=>{const d=new THREE.Vector3().subVectors(b,a),len=d.length(),m=new THREE.Mesh(new THREE.CylinderGeometry(r,r,len,6),M.metal);
   m.position.copy(a).addScaledVector(d,0.5);m.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),d.normalize());m.castShadow=true;tower.add(m);};
 towerBeacons.push(0,CT+0.25,0);}


/* ===================== Tower close-range detail ===================== */
const towerDetail=new THREE.Group();tower.add(towerDetail);
const crownLights=[];
function vineTexture(){
  const W=256,Hh=512,[c,g]=[document.createElement('canvas'),null];c.width=W;c.height=Hh;const x=c.getContext('2d');
  x.clearRect(0,0,W,Hh);
  for(let i=0;i<70;i++){const cx=R()*W,len=Hh*rand(0.25,1),w=rand(4,14);
    for(let y=0;y<len;y+=3){const a=1-y/len,ww=w*(0.5+a*0.7);
      x.fillStyle='rgba('+Math.round(rand(70,120))+','+Math.round(rand(90,125))+','+Math.round(rand(35,60))+','+(0.5+a*0.5)+')';
      x.beginPath();x.ellipse(cx+Math.sin(y*0.05+i)*4,y,ww*rand(0.5,1),rand(2,5),0,0,TAU);x.fill();}}
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=ANISO;return t;
}
M.band=std({color:0xa9b1b8,metalness:0.75,roughness:0.32});
M.mullion=std({color:0x9aa3ab,metalness:0.85,roughness:0.28});
M.balustrade=std({color:0xcfe0e8,metalness:0.3,roughness:0.04,transparent:true,opacity:0.16,depthWrite:false});
M.crownGlow=std({color:0x9c968c,metalness:0.6,roughness:0.3,emissive:0xffd9a0,emissiveIntensity:0});
M.canopyWhite=std({color:0xf1f1ee,roughness:0.6,metalness:0.1});
[M.band,M.mullion,M.balustrade,M.crownGlow,M.canopyWhite].forEach(m=>{m.color.convertSRGBToLinear();if(m.emissive)m.emissive.convertSRGBToLinear();});
REFLECTIVE.push(M.band,M.mullion,M.balustrade,M.crownGlow);
function dStrut(a,b,r){const d=new THREE.Vector3().subVectors(b,a),len=d.length(),m=new THREE.Mesh(new THREE.CylinderGeometry(r,r,len,6),M.metal);
  m.position.copy(a).addScaledVector(d,0.5);m.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),d.normalize());return m;}
function plankTex(){const [c,g]=makeCanvas(256);g.fillStyle='#8a6a4c';g.fillRect(0,0,256,256);
  for(let y=0;y<256;y+=16){for(let x=-((y/16)%2)*48;x<256;x+=96){g.fillStyle='hsl('+rand(24,32)+','+rand(30,42)+'%,'+rand(34,44)+'%)';g.fillRect(x+1,y+1,94,14);}}
  return tex(c,true);}
function louvreTex(){const [c,g]=makeCanvas(128);g.fillStyle='#6d747a';g.fillRect(0,0,128,128);
  for(let y=0;y<128;y+=8){g.fillStyle='#3a3f44';g.fillRect(0,y+5,128,3);g.fillStyle='#8c9399';g.fillRect(0,y,128,1);}
  for(let x=0;x<128;x+=32){g.fillStyle='#50575d';g.fillRect(x,0,2,128);}
  return tex(c,true);}
const POOL_N=WATER_N.clone();POOL_N.needsUpdate=true;POOL_N.repeat.set(1.5,1.5);
M.poolWater=std({color:0x45b3cf,metalness:0.35,roughness:0.04,normalMap:POOL_N,normalScale:new THREE.Vector2(0.22,0.22),emissive:0x2a9fc0,emissiveIntensity:0});
M.deck=std({map:plankTex(),roughness:0.75});
M.coping=std({color:0xe7e3da,roughness:0.6});
M.skyGlass=std({color:0xd3e6f0,metalness:0.9,roughness:0.03,transparent:true,opacity:0.3,depthWrite:false});
const LOUVRE_T=louvreTex();LOUVRE_T.repeat.set(1.2,1.4);
M.louvre=std({map:LOUVRE_T,metalness:0.55,roughness:0.45});
M.bmu=std({color:0xeae8e0,metalness:0.45,roughness:0.45});
M.lounger=std({color:0xf4f2ec,roughness:0.6});
M.shade=std({color:0xece4d2,roughness:0.85,side:THREE.DoubleSide});
[M.poolWater,M.coping,M.skyGlass,M.bmu,M.lounger,M.shade].forEach(m=>{m.color.convertSRGBToLinear();if(m.emissive)m.emissive.convertSRGBToLinear();});
M.terrace.color.copy(lin('#d4cfc5'));
{const [c,g]=makeCanvas(256);g.fillStyle='#8f8a80';g.fillRect(0,0,256,256);
 for(let y=0;y<256;y+=32)for(let x=0;x<256;x+=64){const o=(y/32)%2*32;g.fillStyle='hsl(38,'+rand(6,12)+'%,'+rand(76,86)+'%)';g.fillRect((x+o)%256+1,y+1,62,30);if((x+o)%256>192)g.fillRect((x+o)%256-255,y+1,62,30);}
 const t=tex(c,true);t.repeat.set(2.5,5);M.terrace.map=t;M.terrace.needsUpdate=true;}
REFLECTIVE.push(M.poolWater,M.skyGlass,M.louvre,M.bmu);
const soffitLights=[];
function buildTowerDetail(CB,CT,strut){
  const T=TOWER,finList=[],unit=new THREE.BoxGeometry(1,1,1),q=new THREE.Quaternion(),up=new THREE.Vector3(0,1,0),mm=new THREE.Matrix4();
  const loungers=[],poles=[],shades=[];
  const alongWing=(x,t,a)=>wingToWorld(x,-t,a);
  const piece=(geo,mat,x,y,z,ry,cast)=>{const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);m.rotation.y=ry;m.castShadow=!!cast;m.receiveShadow=true;towerDetail.add(m);return m;};
  for(let i=0;i<T.nseg;i++){
    const yb=T.y0+i*T.segH,last=i===T.nseg-1,hB=last?T.segH:T.segH-T.gap,W=4.6-0.17*i,coreR=3.6-0.1*i+0.25;
    const floors=Math.floor(hB/0.42),mechF=Math.round(floors*0.5);
    for(let k=0;k<3;k++){
      const a=k*TAU/3,L=wingLen(i,k);
      // slab-edge band on every storey, skipping the mechanical floors
      const ring=wingRing(W,L,0.09,0.055),bands=new THREE.InstancedMesh(ring,M.band,floors);let nb=0;
      for(let f=0;f<floors;f++){if(f===mechF-1||f===mechF)continue;mm.makeRotationY(a);mm.setPosition(0,yb+(f+1)*0.42-0.03,0);bands.setMatrixAt(nb++,mm);}
      bands.count=nb;bands.receiveShadow=true;towerDetail.add(bands);
      // two-storey louvred plant room band, as on real supertalls
      piece(wingRing(W,L,0.07,0.84),[M.louvre,M.louvre],0,yb+(mechF-1)*0.42+0.42,0,a,false);
      // unitised curtain wall: mullion every 1.5 m
      wingOutline(W,L,0.15).forEach(p=>{
        const [wx,wz]=wingToWorld(p[0],p[1],a);if(Math.hypot(wx,wz)<coreR)return;
        const [nx,nz]=wingToWorld(p[2],p[3],a);
        finList.push({x:wx+nx*0.05,z:wz+nz*0.05,y:yb,h:hB,ry:Math.atan2(nx,nz),d:0.1});
      });
      // setback terrace: timber deck, infinity pool, loungers, shades, balustrade, façade-cleaning crane
      if(i>0){const Lp=wingLen(i-1,k),Wp=4.6-0.17*(i-1),rp=wingR(Wp),yT=yb-T.gap;
        if(Lp-L>0.8){
          piece(wingRing(Wp,Lp,0.0,0.11),M.balustrade,0,yT,0,a,false);
          piece(wingRing(Wp,Lp,0.01,0.012),M.metal,0,yT+0.11,0,a,false);
          const t0=L+0.1,t1=Lp-0.25-rp*0.35,dw=Wp-0.6;
          const [dx,dz]=alongWing(0,(t0+t1)/2,a);piece(new THREE.BoxGeometry(dw,0.04,t1-t0),M.deck,dx,yT+0.02,dz,a,false);
          // infinity pool runs across the wing tip, edge toward the view; loungers line the inner side
          const pl=Math.min(Wp*0.62,dw-0.4),pd=Math.min(0.62,(t1-t0)*0.4),pc=t1-pd/2-0.12;
          if(t1-t0>0.9){
            const [px,pz]=alongWing(0,pc,a);
            piece(new THREE.BoxGeometry(pl+0.16,0.05,pd+0.16),M.coping,px,yT+0.045,pz,a,false);
            piece(new THREE.BoxGeometry(pl,0.02,pd),M.poolWater,px,yT+0.075,pz,a,false);
            const lt=pc-pd/2-0.24;
            let n=0;for(let x=-pl/2+0.08;x<pl/2-0.05;x+=0.15,n++){const [lx,lz]=alongWing(x,lt,a);
              if(n%4===3){poles.push([lx,yT+0.04,lz]);shades.push([lx,yT+0.34,lz]);}else loungers.push([lx,yT+0.04,lz,a]);}
          }
          const [bx,bz]=alongWing(Wp*0.33,L+0.35,a);
          piece(new THREE.BoxGeometry(0.42,0.22,0.42),M.bmu,bx,yT+0.13,bz,a,true);
          piece(new THREE.BoxGeometry(0.1,0.9,0.1),M.bmu,bx,yT+0.65,bz,a,true);
          const [bx2,bz2]=alongWing(Wp*0.33,L+1.05,a);piece(new THREE.BoxGeometry(0.08,0.08,1.5),M.bmu,bx2,yT+1.08,bz2,a,true);
        }}
      // sky lobby in the wind gap: set-back double-height glazing, soffit downlights
      if(!last){
        const Ln=Math.min(L,wingLen(i+1,k)),Wn=Math.min(W,4.6-0.17*(i+1));
        const glass=new THREE.ExtrudeGeometry(wingShape(Wn,Ln,-0.55),{depth:T.gap-0.04,bevelEnabled:false,curveSegments:8});glass.rotateX(-Math.PI/2);
        piece(glass,M.skyGlass,0,yb+hB+0.02,0,a,false);
        wingOutline(Wn,Ln,0.7).forEach(p=>{const [wx,wz]=wingToWorld(p[0]-p[2]*0.3,p[1]-p[3]*0.3,a);if(Math.hypot(wx,wz)>coreR+0.4)soffitLights.push(wx,yb+T.segH-0.05,wz);});
      }
    }
  }
  const fins=new THREE.InstancedMesh(unit.clone().translate(0,0.5,0),M.mullion,finList.length);
  finList.forEach((f,j)=>{q.setFromAxisAngle(up,f.ry);mm.compose(new THREE.Vector3(f.x,f.y,f.z),q,new THREE.Vector3(0.028,f.h,f.d));fins.setMatrixAt(j,mm);});
  towerDetail.add(fins);
  const inst=(geo,mat,list,sc,rot)=>{const im=new THREE.InstancedMesh(geo,mat,list.length);list.forEach((p,j)=>{q.setFromAxisAngle(up,rot?p[3]:0);mm.compose(new THREE.Vector3(p[0],p[1],p[2]),q,sc);im.setMatrixAt(j,mm);});im.castShadow=true;im.receiveShadow=true;towerDetail.add(im);};
  inst(unit.clone().translate(0,0.5,0),M.lounger,loungers,new THREE.Vector3(0.08,0.035,0.2),true);
  inst(new THREE.CylinderGeometry(0.012,0.012,0.3,5).translate(0,0.15,0),M.metal,poles,new THREE.Vector3(1,1,1));
  inst(new THREE.ConeGeometry(0.2,0.08,8,1,true),M.shade,shades,new THREE.Vector3(1,1,1));
  // 6) floating roof canopy with radial trusses (Le Nouvel)
  {const y=CB+0.35,R0=4.7;
   M.canopyGlass=std({color:0xdfeaf0,metalness:0.9,roughness:0.06,transparent:true,opacity:0.28,depthWrite:false});M.canopyGlass.color.convertSRGBToLinear();REFLECTIVE.push(M.canopyGlass);
   const plate=new THREE.Mesh(new THREE.CylinderGeometry(R0,R0,0.04,6),M.canopyGlass);plate.position.y=y;plate.rotation.y=Math.PI/6;tower.add(plate);
   const hub=new THREE.Vector3(0,y+0.9,0);
   for(let j=0;j<12;j++){const an=j/12*TAU;tower.add(strut(hub,new THREE.Vector3(Math.sin(an)*(R0-0.2),y+0.03,Math.cos(an)*(R0-0.2)),0.035));}
   for(let j=0;j<6;j++){const a0=j/6*TAU+Math.PI/6,a1=(j+1)/6*TAU+Math.PI/6;
     tower.add(strut(new THREE.Vector3(Math.sin(a0)*R0,y,Math.cos(a0)*R0),new THREE.Vector3(Math.sin(a1)*R0,y,Math.cos(a1)*R0),0.05));
     tower.add(strut(new THREE.Vector3(Math.sin(a0)*R0*0.55,y+0.02,Math.cos(a0)*R0*0.55),new THREE.Vector3(Math.sin(a1)*R0*0.55,y+0.02,Math.cos(a1)*R0*0.55),0.03));}}
  // 7) Jin Mao-style stepped crown: tiers, cornices, corner fins, chevrons, rim lights, spire
  const tiers=[[3.3,1.6],[2.85,1.5],[2.4,1.4],[1.95,1.3],[1.5,1.2],[1.05,1.1]];
  let y=CB+0.5;
  tiers.forEach(([r,h],ti)=>{
    const body=new THREE.Mesh(new THREE.CylinderGeometry(r*0.9,r,h,6),[M.tower,M.roof,M.roof]);body.position.y=y+h/2;body.rotation.y=Math.PI/6;body.castShadow=true;tower.add(body);
    const corn=new THREE.Mesh(new THREE.CylinderGeometry(r+0.28,r+0.2,0.16,6),M.crownGlow);corn.position.y=y+h;corn.rotation.y=Math.PI/6;tower.add(corn);
    for(let v=0;v<6;v++){
      const an=v/6*TAU,an2=(v+1)/6*TAU,mid=(an+an2)/2;
      const cx=Math.sin(an),cz=Math.cos(an);
      const fin=new THREE.Mesh(new THREE.BoxGeometry(0.1,h+0.3,0.36),M.mullion);fin.position.set(cx*(r+0.05),y+h/2+0.1,cz*(r+0.05));fin.rotation.y=an;tower.add(fin);
      const top1=new THREE.Vector3(cx*r*0.97,y+h*0.95,cz*r*0.97),top2=new THREE.Vector3(Math.sin(an2)*r*0.97,y+h*0.95,Math.cos(an2)*r*0.97),
            bot=new THREE.Vector3(Math.sin(mid)*r*0.93,y+0.08,Math.cos(mid)*r*0.93);
      tower.add(strut(top1,bot,0.035));tower.add(strut(top2,bot,0.035));
      const rr=r+0.3;crownLights.push(cx*rr,y+h+0.1,cz*rr,Math.sin(mid)*rr*0.9,y+h+0.1,Math.cos(mid)*rr*0.9);
    }
    y+=h;
  });
  const spire=new THREE.Mesh(new THREE.ConeGeometry(0.38,CT-y,6),M.metal);spire.position.y=y+(CT-y)/2;spire.castShadow=true;tower.add(spire);
}
buildTowerDetail(TOWER.y0+TOWER.nseg*TOWER.segH,TOWER.top,dStrut);

/* ===================== Night lights & traffic ===================== */
await step('조명과 교통');
function pointCloud(pos,cols,size){
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  if(cols)g.setAttribute('color',new THREE.Float32BufferAttribute(cols,3));
  const m=new THREE.PointsMaterial({size:size,map:DOT,vertexColors:!!cols,color:0xffffff,transparent:true,opacity:0,depthWrite:false,blending:THREE.AdditiveBlending});
  const p=new THREE.Points(g,m);p.frustumCulled=false;p.visible=false;scene.add(p);return p;
}
const streetLights=(function(){
  const pos=[],col=[],warm=lin('#ffbf73'),white=lin('#ffe9c4');
  const push=(x,z,c)=>{if(Math.hypot(x,z)>EDGE+2)return;pos.push(x,0.6,z);col.push(c.r,c.g,c.b);};
  rings.forEach(g=>{const c=g.main?white:warm,step=g.main?2.4:3.2;[-1,1].forEach(s=>{const r=g.r+s*(g.w/2+0.3),n=Math.round(TAU*r/step);for(let i=0;i<n;i++){const [x,z]=polar(r,i/n*TAU);push(x,z,c);}});});
  for(let z=0;z<5;z++)spokes[z].forEach(s=>{if(s.blvd)return;const tx=Math.cos(s.a),tz=-Math.sin(s.a);
    for(let r=ZB[z];r<ZB[z+1];r+=3.2){const [x,z2]=polar(r,s.a);[-1,1].forEach(o=>push(x+tx*o*(s.w/2+0.3),z2+tz*o*(s.w/2+0.3),warm));}});
  for(let k=0;k<3;k++){const a=k*TAU/3,tx=Math.cos(a),tz=-Math.sin(a);
    for(let r=30;r<EDGE;r+=2.2){const [x,z]=polar(r,a);[-4.3,-1.6,1.6,4.3].forEach(o=>push(x+tx*o,z+tz*o,white));}}
  return pointCloud(pos,col,0.75);
})();
// Cars run on lanes that know where the stop lines are; see world/traffic.js.
// `signalGreen` is read once per frame there, and it is the same function the
// signal heads use, so a red light and a stopped car can never disagree.
const junctions=planJunctions({rings:rings});
const traffic=createTraffic({
  rings:rings,
  junctions:junctions,
  carMaterial:M.car,
  makePoints:pointCloud,
  signalGreen:function(ph){return signalStateAt(signalT,ph)==='green';}
});
scene.add(traffic.mesh);
console.info('교통: 차량 '+traffic.count+' · 차선 '+traffic.laneCount+' · 교차로 '+junctions.length);
const soffitPts=pointCloud(soffitLights,null,0.5);soffitPts.material.color.copy(lin('#ffe2b5'));
const crownPts=pointCloud(crownLights,null,0.42);crownPts.material.color.copy(lin('#ffdcaa'));
const beaconPts=pointCloud(beacons.concat(towerBeacons),null,2.2);beaconPts.material.color.copy(lin('#ff3b30'));

/* ===================== Clouds ===================== */
const cloudMats=[1,2,3].map(s=>new THREE.SpriteMaterial({map:cloudTex(s*977),color:0xffffff,transparent:true,opacity:0.95,depthWrite:false}));
for(let c=0;c<30;c++){const a=R()*TAU,r=rand(520,1400),s=new THREE.Sprite(pick(cloudMats)),w=rand(80,190);
  s.scale.set(w,w*rand(0.42,0.55),1);s.position.set(Math.sin(a)*r,rand(90,135),Math.cos(a)*r);scene.add(s);}

/* ===================== Labels & comparison ===================== */
function label(text,x,y,z,width,parent){
  const cv=document.createElement('canvas');cv.width=1024;cv.height=176;const t=new THREE.CanvasTexture(cv);t.colorSpace=THREE.SRGBColorSpace;
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:t,depthTest:false,transparent:true,fog:false,toneMapped:false}));
  sp.scale.set(width,width*176/1024,1);sp.position.set(x,y,z);sp.renderOrder=20;parent.add(sp);
  const draw=()=>{const g=cv.getContext('2d');g.clearRect(0,0,1024,176);g.font='500 72px "IBM Plex Sans KR","Apple SD Gothic Neo",sans-serif';
    const w=Math.min(1000,g.measureText(text).width+84),x0=(1024-w)/2,r=46;
    g.fillStyle='rgba(16,24,34,.8)';g.beginPath();g.moveTo(x0+r,22);g.arcTo(x0+w,22,x0+w,154,r);g.arcTo(x0+w,154,x0,154,r);g.arcTo(x0,154,x0,22,r);g.arcTo(x0,22,x0+w,22,r);g.closePath();g.fill();
    g.fillStyle='#fff';g.textAlign='center';g.textBaseline='middle';g.fillText(text,512,90);t.needsUpdate=true;};
  draw();return {sprite:sp,draw:draw};
}
const allLabels=[];
const ghosts=new THREE.Group();ghosts.visible=false;scene.add(ghosts);
{const gm=new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:0.42,depthWrite:false,toneMapped:false}),em=new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:0.9,toneMapped:false});
 const add=(geo,x,y,z,ry)=>{const m=new THREE.Mesh(geo,gm);m.position.set(x,y,z);m.rotation.y=ry||0;ghosts.add(m);const e=new THREE.LineSegments(new THREE.EdgesGeometry(geo),em);e.position.copy(m.position);e.rotation.y=ry||0;ghosts.add(e);};
 const [lx,lz]=polar(GHOSTS[0].r,GHOSTS[0].th),[bx,bz]=polar(GHOSTS[1].r,GHOSTS[1].th);
 add(new THREE.CylinderGeometry(0.6,3.6,55.5,4),lx,27.75,lz,Math.PI/4);
 add(new THREE.CylinderGeometry(2.4,4.2,45,3),bx,22.5,bz);add(new THREE.CylinderGeometry(1.4,2.4,25,3),bx,57.5,bz);add(new THREE.CylinderGeometry(0.15,1.4,12.8,6),bx,76.4,bz);
 allLabels.push(label(GHOSTS[0].name,lx,64,lz,40,ghosts),label(GHOSTS[1].name,bx,92,bz,40,ghosts),label('1마일 타워 1,609m',0,172,0,40,ghosts));}
const districtLabels=new THREE.Group();scene.add(districtLabels);
{const a=TAU/6;[['중앙공원',45],['업무지구',90],['복합지구',162],['주거지구',246],['저층주거',340]].forEach(([n,r])=>{const [x,z]=polar(r,a);allLabels.push(label(n,x,8,z,120,districtLabels));});
 allLabels.push(label('수변공원',Math.cos(RIVER.a)*RIVER.d,8,-Math.sin(RIVER.a)*RIVER.d,120,districtLabels));}
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(()=>allLabels.forEach(l=>l.draw()));

/* ===================== Sun path, sky and weather ===================== */
/*
  Solar position is computed for 37.5°N on 21 September (equinox) in local solar time.
  North is -z, east is +x. Sky, light, fog, windows and street lighting blend continuously
  from the sun's elevation; weather (overcast, rain, fog deck) layers on top.
*/

const CLOCK={hour:13,target:13,play:false,rate:0.9};   // rate: hours per second while playing
const WX={overcast:0,rain:0,fog:0,wet:0},WXT={overcast:0,rain:0,fog:0},WX_PRESET={clear:{overcast:0,rain:0,fog:0},rain:{overcast:1,rain:1,fog:0.35},fog:{overcast:0.7,rain:0,fog:1}};
let wxKey='clear',flash=0,flashT=4;
function solar(hour){
  const decl=23.44*Math.PI/180*Math.sin(TAU*(284+SITE.day)/365),H=(hour-12)*Math.PI/12,lat=SITE.lat;
  const el=Math.asin(Math.sin(lat)*Math.sin(decl)+Math.cos(lat)*Math.cos(decl)*Math.cos(H));
  let az=Math.acos(clamp((Math.sin(decl)-Math.sin(el)*Math.sin(lat))/(Math.cos(el)*Math.cos(lat)),-1,1));if(H>0)az=TAU-az;
  return {el:el,az:az};
}
const S=parsePreset(PRESETS.day),TMP=parsePreset(PRESETS.day),lightDir=new THREE.Vector3(0.5,0.7,0.4).normalize();
let envKey='day',elevDeg=40;
const GRAY=new THREE.Color();
function mixState(dst,a,b,t){COLOR_KEYS.forEach(c=>dst[c].copy(a[c]).lerp(b[c],t));NUM_KEYS.forEach(n=>dst[n]=a[n]+(b[n]-a[n])*t);}
function toGray(c,amt,tint){const l=c.r*0.3+c.g*0.59+c.b*0.11;GRAY.setRGB(l*(tint||1)*0.98,l*(tint||1),l*(tint||1)*1.05);c.lerp(GRAY,amt);}
// wet materials keep their dry values so rain can darken and polish them
[M.road,M.sidewalk,M.paving,M.ground,M.grass,M.terrace,M.country,M.stone].forEach(m=>m.envMapIntensity=0.3);
// Signal cycle. Two phases in opposition, so a junction always reads as one
// direction moving and the other held. Amber only appears on the way to red,
// which is the part that makes it look like a real signal rather than a
// flashing light.
const SIGNAL_CYCLE={green:11,amber:2.5,red:1.0};   // seconds; red is the all-red overlap
const SIGNAL_PERIOD=(SIGNAL_CYCLE.green+SIGNAL_CYCLE.amber+SIGNAL_CYCLE.red)*2;
let signalT=0;

/** Which lamp is lit for a phase, at time t within the cycle. */
function signalStateAt(t,phase){
  const half=SIGNAL_PERIOD/2;
  const local=((t+(phase?half:0))%SIGNAL_PERIOD+SIGNAL_PERIOD)%SIGNAL_PERIOD;
  if(local<SIGNAL_CYCLE.green)return 'green';
  if(local<SIGNAL_CYCLE.green+SIGNAL_CYCLE.amber)return 'amber';
  return 'red';
}

function signalStep(dt){
  signalT+=dt;
  // Lenses are dim but not black when unlit — a signal head in daylight still
  // shows its lamps, and at night the housing would otherwise vanish.
  const dayOff=0.015,nightOff=0.03;
  const off=dayOff+(nightOff-dayOff)*S.street;
  const on=1.6+1.9*S.street;
  for(let ph=0;ph<2;ph++){
    const lit=signalStateAt(signalT,ph);
    ['red','amber','green'].forEach(k=>{
      SIGNAL_LENS[ph+k].emissiveIntensity=(k===lit?on:off);
    });
  }
}

const WETTABLE=[[M.road,0.62],[M.sidewalk,0.55],[M.paving,0.55],[M.ground,0.5],[M.grass,0.25],[M.terrace,0.5],[M.stone,0.45],[M.concrete,0.3],[M.concreteFlat,0.3]];
WETTABLE.forEach(w=>{w[2]=w[0].roughness;w[3]=w[0].color.clone();});
function computeSky(){
  const s=solar(CLOCK.hour);elevDeg=s.el*180/Math.PI;
  const tSet=smooth(-14,-3,elevDeg),tDay=smooth(-3,13,elevDeg);
  mixState(TMP,PARSED.night,PARSED.sunset,tSet);mixState(S,TMP,PARSED.day,tDay);
  // the sky shader gets the true sun (glow below the horizon at dusk); the light is kept above it
  S.sunDir.set(Math.sin(s.az)*Math.cos(s.el),Math.sin(s.el),-Math.cos(s.az)*Math.cos(s.el)).normalize();
  const moon=PARSED.night.sunDir,sunUp=new THREE.Vector3(S.sunDir.x,Math.max(S.sunDir.y,0.06),S.sunDir.z).normalize();
  lightDir.copy(moon).lerp(sunUp,smooth(-10,-2,elevDeg)).normalize();
  const want=tDay>0.5?'day':tSet>0.5?'sunset':'night';
  if(want!==envKey){envKey=want;setEnv(ENV[envKey]);}
  // weather layers
  const o=WX.overcast,f=WX.fog,r=WX.rain;
  ['skyTop','skyHor','skyGround'].forEach(k=>toGray(S[k],o*0.85,0.95));
  toGray(S.fog,Math.max(o*0.8,f),1);toGray(S.hemiSky,o*0.7,1);toGray(S.cloud,o*0.6,0.85);
  S.lightI*=1-0.82*o;S.sunGlow*=1-0.9*o;S.sunDisk*=1-o;S.hemiI*=1+0.3*o;S.exposure*=1-0.08*o;
  S.fogNear*=1-0.8*f-0.35*r;S.fogFar*=1-0.72*f-0.4*r;S.cloudOp=Math.min(1,S.cloudOp+0.1*o);
  if(flash>0){S.hemiI+=flash*2.2;S.skyTop.lerp(GRAY.setRGB(0.8,0.82,0.9),flash*0.6);S.skyHor.lerp(GRAY.setRGB(0.85,0.86,0.92),flash*0.6);}
}
function applyState(){
  skyUni.top.value.copy(S.skyTop);skyUni.hor.value.copy(S.skyHor);skyUni.gnd.value.copy(S.skyGround);
  skyUni.sunCol.value.copy(S.sunCol);skyUni.sunDir.value.copy(S.sunDir);skyUni.glow.value=S.sunGlow;skyUni.disk.value=S.sunDisk;
  scene.fog.color.copy(S.fog);
  hemi.color.copy(S.hemiSky);hemi.groundColor.copy(S.hemiGround);hemi.intensity=S.hemiI*Math.PI;
  sun.color.copy(S.lightCol);sun.intensity=S.lightI*Math.PI;
  renderer.toneMappingExposure=S.exposure;
  WINDOW_MATS.forEach(([m,f])=>m.emissiveIntensity=S.glow*f);
  M.garden.emissiveIntensity=S.garden;M.fin.emissiveIntensity=S.fins*0.3;M.road.emissiveIntensity=S.roadGlow*0.5*(1+WX.wet*0.5);
  M.lantern.opacity=0.1+S.garden*0.6;
  M.crownGlow.emissiveIntensity=S.garden*0.28;crownPts.material.opacity=Math.min(1,S.garden);crownPts.visible=S.garden>0.02;
  soffitPts.material.opacity=Math.min(1,S.garden);M.poolWater.emissiveIntensity=S.garden*0.35;
  streetLights.material.opacity=S.street;streetLights.visible=S.street>0.01;
  M.lampLens.emissiveIntensity=S.street*2.6;
  traffic.groups.forEach(g=>{g.material.opacity=S.traffic;g.visible=S.traffic>0.01;});
  stars.material.opacity=S.stars*(1-WX.overcast);stars.visible=stars.material.opacity>0.01;
  cloudMats.forEach(m=>{m.color.copy(S.cloud);m.opacity=S.cloudOp;});
  WETTABLE.forEach(([m,k,r0,c0])=>{m.roughness=r0*(1-k*WX.wet);m.color.copy(c0).multiplyScalar(1-0.32*k*WX.wet);});
  deckMat.color.copy(S.cloud).lerp(S.fog,0.5);deckMat.opacity=Math.max(WX.fog,WX.overcast*0.8)*0.9;deck.visible=deckMat.opacity>0.02;
  deck.position.y=90-35*WX.fog;
  rainMat.uniforms.opacity.value=WX.rain*(0.35+0.4*smooth(-6,6,-elevDeg+6));rain.visible=WX.rain>0.02;
  rainMat.uniforms.color.value.copy(S.fog).lerp(GRAY.setRGB(0.8,0.82,0.86),0.6);
}
// low cloud deck: tower top pierces it on foggy days
const deckMat=new THREE.SpriteMaterial({map:cloudTex(4242),color:0xffffff,transparent:true,opacity:0,depthWrite:false});
const deck=new THREE.Group();scene.add(deck);
for(let i=0;i<160;i++){const a=R()*TAU,r=Math.sqrt(R())*950,s=new THREE.Sprite(deckMat),w=rand(140,300);
  s.scale.set(w,w*rand(0.28,0.4),1);s.position.set(Math.sin(a)*r,rand(-10,10),Math.cos(a)*r);deck.add(s);}
// GPU rain: streaks wrap around the camera in world space, so they stay put while you move
// rain lives in world/rain.js now; rainMat keeps the .uniforms shape the weather step writes to
const _rain=createRain(R);
const RAIN_BOX=_rain.BOX,rain=_rain.mesh,rainMat={uniforms:_rain.uniforms};
scene.add(rain);
function fmtClock(h){h=((h%24)+24)%24;const hh=Math.floor(h),mm=Math.floor((h-hh)*60);return (hh<10?'0':'')+hh+':'+(mm<10?'0':'')+mm;}
function setHour(h,instant){CLOCK.target=h;if(instant)CLOCK.hour=h;}
function setWeather(k){wxKey=k;Object.assign(WXT,WX_PRESET[k]);document.querySelectorAll('[data-wx]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.wx===k)));}
function envStep(raw){
  if(CLOCK.play){CLOCK.hour=(CLOCK.hour+raw*CLOCK.rate)%24;CLOCK.target=CLOCK.hour;}
  else{let d=CLOCK.target-CLOCK.hour;if(Math.abs(d)>12)d-=Math.sign(d)*24;CLOCK.hour=(CLOCK.hour+d*(1-Math.exp(-raw*2.6))+24)%24;}
  const k=1-Math.exp(-raw*0.8);['overcast','rain','fog'].forEach(n=>WX[n]+=(WXT[n]-WX[n])*k);
  WX.wet+=((WX.rain>0.3?1:0)-WX.wet)*(1-Math.exp(-raw*(WX.rain>0.3?0.35:0.06)));
  if(WX.rain>0.7){flashT-=raw;if(flashT<0){flash=1;flashT=rand(5,14);}}
  flash=Math.max(0,flash-raw*(flash>0.6?9:3));
  rainMat.uniforms.time.value+=raw;rainMat.uniforms.cam.value.copy(camera.position);
  computeSky();applyState();
  const sl=$('#hour');if(sl&&document.activeElement!==sl)sl.value=CLOCK.hour.toFixed(2);
  const ck=$('#clock');if(ck)ck.textContent=fmtClock(CLOCK.hour);
}
setEnv(ENV.day);computeSky();applyState();

/* ===================== Camera rig: orbit + pan + free look ===================== */
const cam=Object.assign({},VIEWS.bird);let goal=null,vT=0,vP=0,lastInteract=-10,clockT=0;
const camRight=new THREE.Vector3(),camFwd=new THREE.Vector3();
function applyCam(){
  cam.r=clamp(cam.r,0.6,4000);
  cam.phi=clamp(cam.phi,0.08,2.62);
  cam.ty=clamp(cam.ty,-240,420);
  const rad=Math.hypot(cam.tx,cam.tz);
  if(rad>1000){cam.tx*=1000/rad;cam.tz*=1000/rad;}
  const s=Math.sin(cam.phi);
  let px=cam.tx+cam.r*s*Math.sin(cam.theta),py=cam.ty+cam.r*Math.cos(cam.phi),pz=cam.tz+cam.r*s*Math.cos(cam.theta);
  if(py<1.6){cam.ty+=1.6-py;py=1.6;}            // keep the eye above the street; tilting further looks up
  camera.position.set(px,py,pz);
  camera.lookAt(cam.tx,cam.ty,cam.tz);
  camRight.set(Math.cos(cam.theta),0,-Math.sin(cam.theta));
  camFwd.set(-Math.sin(cam.theta),0,-Math.cos(cam.theta));
}
const pointers=new Map();
const hint=$('#hint');
function touched(){lastInteract=clockT;goal=null;if(hint)hint.classList.add('gone');}
/*
  1 finger  : look around — orbit the view 360° and tilt
  2 fingers : drag the ground (the grabbed point stays under the fingers), pinch to zoom, twist to rotate
  desktop   : left drag looks, right/middle/shift drag pans, wheel zooms at the cursor, double click zooms in
*/
const _ndc=new THREE.Vector2(),_ray=new THREE.Raycaster(),_plane=new THREE.Plane(new THREE.Vector3(0,1,0),0),
      _hit=new THREE.Vector3(),_grab=new THREE.Vector3();
const ROT_DEAD=0.12,R_MIN=0.6,R_MAX=4000;
let grabbed=false,panVX=0,panVZ=0,lastMoveT=0,two=null,downAt=null,lastTap=0,wheelA=null,wheelT=0,wheelXY={x:0,y:0};
const angDiff=(a,b)=>Math.atan2(Math.sin(a-b),Math.cos(a-b));
function groundAt(px,py,out){
  _ndc.set(px/window.innerWidth*2-1,-(py/window.innerHeight*2-1));
  _ray.setFromCamera(_ndc,camera);_plane.constant=-Math.min(cam.ty,10);
  return _ray.ray.intersectPlane(_plane,out);
}
function sync(){applyCam();camera.updateMatrixWorld(true);}
function startGrab(px,py){grabbed=!!groundAt(px,py,_grab);panVX=panVZ=0;lastMoveT=performance.now();}
function screenPan(dx,dy){
  const k=2*Math.tan(camera.fov*Math.PI/360)*Math.max(cam.r,4)/window.innerHeight;
  cam.tx-=(camRight.x*dx+camFwd.x*-dy)*k;cam.tz-=(camRight.z*dx+camFwd.z*-dy)*k;sync();
}
function anchorTo(px,py){
  if(!grabbed||!groundAt(px,py,_hit))return false;
  const dx=_grab.x-_hit.x,dz=_grab.z-_hit.z;
  cam.tx+=dx;cam.tz+=dz;
  const now=performance.now(),dt=Math.max(0.008,(now-lastMoveT)/1000);lastMoveT=now;
  panVX=clamp(dx/dt,-3000,3000);panVZ=clamp(dz/dt,-3000,3000);
  sync();return true;
}
function look(dx,dy){cam.theta-=dx*0.006;cam.phi-=dy*0.005;sync();}
// surface under the pointer: tower, buildings, trees, else the ground plane
function pickPoint(px,py){
  _ndc.set(px/window.innerWidth*2-1,-(py/window.innerHeight*2-1));
  _ray.setFromCamera(_ndc,camera);_ray.far=cam.r*8+4000;
  const objs=[tower],lim=cam.r*3+500;
  for(let i=0;i<chunkList.length;i++){const c=chunkList[i];if(c.group.visible&&c.sphere.center.distanceTo(camera.position)-c.sphere.radius<lim)objs.push(c.group);}
  const hits=_ray.intersectObjects(objs,true);
  for(let i=0;i<hits.length;i++){const o=hits[i].object;if(o.isPoints||o.isSprite||o.material===M.lantern)continue;return hits[i].point.clone();}
  _plane.constant=0;const g=new THREE.Vector3();return _ray.ray.intersectPlane(_plane,g)?g:null;
}
function zoom3D(A,f){
  const nr=clamp(cam.r*f,R_MIN,R_MAX);f=nr/cam.r;cam.r=nr;
  if(A){cam.tx=A.x+(cam.tx-A.x)*f;cam.ty=A.y+(cam.ty-A.y)*f;cam.tz=A.z+(cam.tz-A.z)*f;}
  sync();
}
function zoomAt(px,py,f){zoom3D(pickPoint(px,py),f);}
function twoFinger(){
  const p=[...pointers.values()];if(p.length<2)return;
  const d=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y),
        a=Math.atan2(p[1].y-p[0].y,p[1].x-p[0].x),
        m={x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2};
  if(!two){two={d:d,a:a,a0:a,m:m,rotating:false,anchor:pickPoint(m.x,m.y)};return;}
  if(d>4&&Math.abs(d-two.d)>0.4)zoom3D(two.anchor,clamp(two.d/d,0.4,2.5));
  if(!two.rotating&&Math.abs(angDiff(a,two.a0))>ROT_DEAD)two.rotating=true;
  if(two.rotating){cam.theta-=angDiff(a,two.a);sync();}
  if(m.x!==two.m.x||m.y!==two.m.y){const bx=cam.tx,bz=cam.tz;screenPan(m.x-two.m.x,m.y-two.m.y);
    if(two.anchor){two.anchor.x+=cam.tx-bx;two.anchor.z+=cam.tz-bz;}}
  two.d=d;two.a=a;two.m=m;
}
canvas.addEventListener('pointerdown',e=>{
  if(fp)return;
  try{canvas.setPointerCapture(e.pointerId);}catch(err){}
  pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});touched();sync();
  if(pointers.size===1)downAt={x:e.clientX,y:e.clientY,t:performance.now(),moved:0};
  if(pointers.size===2){two=null;twoFinger();}
});
canvas.addEventListener('pointermove',e=>{
  if(fp)return;
  if(!pointers.has(e.pointerId))return;
  const prev=pointers.get(e.pointerId),cur={x:e.clientX,y:e.clientY};
  pointers.set(e.pointerId,cur);lastInteract=clockT;
  if(downAt)downAt.moved+=Math.hypot(cur.x-prev.x,cur.y-prev.y);
  if(pointers.size===1){
    const pan=e.buttons===2||e.buttons===4||e.shiftKey;
    if(pan){if(!grabbed)startGrab(prev.x,prev.y);if(!anchorTo(cur.x,cur.y))screenPan(cur.x-prev.x,cur.y-prev.y);}
    else{vT=-(cur.x-prev.x)*0.006;vP=-(cur.y-prev.y)*0.005;look(cur.x-prev.x,cur.y-prev.y);}
  }else if(pointers.size===2)twoFinger();
});
function endPointer(e){
  if(fp){pointers.delete(e.pointerId);return;}
  pointers.delete(e.pointerId);
  if(pointers.size===1){two=null;grabbed=false;}
  else if(pointers.size===0){
    grabbed=false;two=null;
    const now=performance.now();
    if(downAt&&downAt.moved<8&&now-downAt.t<300){
      if(now-lastTap<320)zoomAt(e.clientX,e.clientY,0.5);
      lastTap=now;
    }
    downAt=null;
  }
}
canvas.addEventListener('pointerup',endPointer);
canvas.addEventListener('pointercancel',endPointer);
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('wheel',e=>{
  // nothing to zoom in first person, so the wheel picks walking pace instead
  if(fp){e.preventDefault();if(!EL.riding)setSpeedIdx(speedIdx+(e.deltaY<0?1:-1));return;}
  e.preventDefault();touched();sync();
  if(e.ctrlKey||Math.abs(e.deltaX)<1){
    const now=performance.now();
    if(!wheelA||now-wheelT>280||Math.hypot(e.clientX-wheelXY.x,e.clientY-wheelXY.y)>6){wheelA=pickPoint(e.clientX,e.clientY);wheelXY={x:e.clientX,y:e.clientY};}
    wheelT=now;zoom3D(wheelA,Math.exp(e.deltaY*0.0018));}
  else screenPan(-e.deltaX,-e.deltaY);
},{passive:false});

/* ===================== First-person mode (Minecraft controls) ===================== */
/*
  Desktop : click to capture the mouse · WASD move · Space jump (double-tap: fly) · Shift sneak / descend
            Ctrl or double-tap W sprint · F5 or V toggles the view · Esc releases the mouse
  Touch   : D-pad move · drag the screen to look · jump (double-tap: fly, hold: ascend) · sneak (descend)
  Scale   : 1 unit = 10 m, so Minecraft metres are divided by 10.
*/
let fp=false;
const PLAYER={x:0,y:0,z:0,vy:0,yaw:0,pitch:0,ground:true,fly:false,sneak:false,sprint:false};
const MC={eye:0.162,eyeSneak:0.127,radius:0.03,height:0.18,walk:0.4317,sprint:0.5612,sneakV:0.1295,fly:1.092,flySprint:2.184,
          flyVert:0.75,gravity:3.2,jump:0.894,step:0.06,fov:70};
const keys={};

// Walking pace is Minecraft's, which is right for looking at a doorway and far
// too slow for crossing a 4.7 km district. The multiplier scales every mode —
// walk, sprint, sneak and fly — so the relationships between them hold.
const SPEEDS=[0.25,0.5,1,2,4,8,16];
let speedIdx=2;
let speedScale=1;
try{const saved=parseInt(localStorage.getItem('fpSpeedIdx'),10);
    if(saved>=0&&saved<SPEEDS.length)speedIdx=saved;}catch{/* private mode */}
speedScale=SPEEDS[speedIdx];

function setSpeedIdx(i){
  speedIdx=clamp(i,0,SPEEDS.length-1);
  speedScale=SPEEDS[speedIdx];
  const el=$('#fpSpeedVal');
  if(el)el.textContent=(speedScale<1?speedScale.toFixed(2).replace(/0+$/,'').replace(/\.$/,''):speedScale.toFixed(1))+'×';
  const slower=$('#fpSlower'),faster=$('#fpFaster');
  if(slower)slower.disabled=speedIdx===0;
  if(faster)faster.disabled=speedIdx===SPEEDS.length-1;
  try{localStorage.setItem('fpSpeedIdx',String(speedIdx));}catch{/* private mode */}
}

const tapT={space:0,w:0};
// ---- colliders: every building mass plus the tower (lobby drum, core, wings per segment)
const colliders=[],CG=10,cgrid=new Map();
function addCollider(c){colliders.push(c);const r=c.round?c.hx:Math.hypot(c.hx,c.hz);
  for(let gx=Math.floor((c.x-r)/CG);gx<=Math.floor((c.x+r)/CG);gx++)for(let gz=Math.floor((c.z-r)/CG);gz<=Math.floor((c.z+r)/CG);gz++){
    const k=gx+','+gz;let a=cgrid.get(k);if(!a){a=[];cgrid.set(k,a);}a.push(c);}}
{const SOLID={curtainCool:1,curtainWarm:1,precast:1,brick:1,apt:1,retail:1,octa:2,round:2};
 chunks.forEach(c=>Object.keys(c.items).forEach(kind=>{const s=SOLID[kind];if(!s)return;
   c.items[kind].forEach(b=>addCollider({x:b.x,z:b.z,c:Math.cos(b.th),s:Math.sin(b.th),hx:b.sx/2,hz:b.sz/2,y0:b.y,y1:b.y+b.sy,round:s===2}));}));
 addCollider({x:0,z:0,c:1,s:0,hx:11.9,hz:11.9,y0:0,y1:4.4,round:true});
 const T=TOWER;
 for(let i=0;i<T.nseg;i++){const yb=T.y0+i*T.segH,last=i===T.nseg-1,hB=last?T.segH:T.segH-T.gap,W=4.6-0.17*i;
   addCollider({x:0,z:0,c:1,s:0,hx:3.6-0.1*i,hz:3.6-0.1*i,y0:yb,y1:yb+T.segH,round:true});
   for(let k=0;k<3;k++){const a=k*TAU/3,L=wingLen(i,k);
     addCollider({x:Math.sin(a)*L/2,z:Math.cos(a)*L/2,c:Math.cos(a),s:Math.sin(a),hx:W/2,hz:L/2,y0:yb,y1:yb+hB,round:false});}}
 addCollider({x:0,z:0,c:1,s:0,hx:3.3,hz:3.3,y0:T.y0+T.nseg*T.segH,y1:T.top,round:true});}
function nearby(x,z){const out=[],seen=new Set();
  for(let gx=Math.floor(x/CG)-1;gx<=Math.floor(x/CG)+1;gx++)for(let gz=Math.floor(z/CG)-1;gz<=Math.floor(z/CG)+1;gz++){
    const a=cgrid.get(gx+','+gz);if(a)for(const c of a)if(!seen.has(c)){seen.add(c);out.push(c);}}return out;}
function toLocal(c,x,z){const dx=x-c.x,dz=z-c.z;return [dx*c.c-dz*c.s,dx*c.s+dz*c.c];}
function toWorld(c,lx,lz){return [lx*c.c+lz*c.s,-lx*c.s+lz*c.c];}
function inside(c,x,z,pad){if(c.round)return Math.hypot(x-c.x,z-c.z)<c.hx+pad;const [lx,lz]=toLocal(c,x,z);return Math.abs(lx)<c.hx+pad&&Math.abs(lz)<c.hz+pad;}
// Inside the district the walkable surface is the street, not y=0. Without
// this the player stands at zero while the carriageway is above their head,
// which is what made the asphalt look like something you could walk through.
const baseGround=(x,z)=>Math.hypot(x,z)<=EDGE+4?ROAD_Y:0;
function supportAt(x,z,feet){let g=baseGround(x,z);for(const c of nearby(x,z))if(c.y1<=feet+MC.step&&c.y1>g&&inside(c,x,z,0))g=c.y1;return g;}
function ceilingAt(x,z,feet){let g=1e9;for(const c of nearby(x,z))if(c.y0>=feet+0.05&&c.y0<g&&inside(c,x,z,0))g=c.y0;return g;}
function pushOut(p){
  const cs=nearby(p.x,p.z);
  for(let it=0;it<3;it++)for(const c of cs){
    if(p.y>=c.y1-MC.step||p.y+MC.height<=c.y0)continue;
    if(c.round){const dx=p.x-c.x,dz=p.z-c.z,d=Math.hypot(dx,dz),m=c.hx+MC.radius;
      if(d<m){const k=d>1e-6?(m-d)/d:0;p.x+=dx*k;p.z+=dz*k;if(d<1e-6)p.x+=m;}continue;}
    const [lx,lz]=toLocal(c,p.x,p.z),cx=clamp(lx,-c.hx,c.hx),cz=clamp(lz,-c.hz,c.hz),ex=lx-cx,ez=lz-cz,d=Math.hypot(ex,ez);
    let nx,nz;
    if(d>1e-6){if(d>=MC.radius)continue;const k=(MC.radius-d)/d;nx=lx+ex*k;nz=lz+ez*k;}
    else{const px=c.hx-Math.abs(lx),pz=c.hz-Math.abs(lz);
      if(px<pz){nx=Math.sign(lx||1)*(c.hx+MC.radius);nz=lz;}else{nx=lx;nz=Math.sign(lz||1)*(c.hz+MC.radius);}}
    const [wx,wz]=toWorld(c,nx,nz);p.x=c.x+wx;p.z=c.z+wz;
  }
}
function fpStep(dt){
  const P=PLAYER;
  const t=(keys.KeyW||keys.ArrowUp||keys.f?1:0)-(keys.KeyS||keys.ArrowDown||keys.b?1:0);
  const st=(keys.KeyD||keys.ArrowRight||keys.r?1:0)-(keys.KeyA||keys.ArrowLeft||keys.l?1:0);
  P.sneak=!!(keys.ShiftLeft||keys.ShiftRight||keys.sneak);
  if(t<=0)P.sprint=false;
  if((keys.ControlLeft||keys.ControlRight||keys.sprintBtn)&&t>0)P.sprint=true;
  let sp=(P.fly?(P.sprint?MC.flySprint:MC.fly):(P.sneak?MC.sneakV:(P.sprint?MC.sprint:MC.walk)))*speedScale;
  const fx=-Math.sin(P.yaw),fz=-Math.cos(P.yaw),rx=Math.cos(P.yaw),rz=-Math.sin(P.yaw);
  let mx=fx*t+rx*st,mz=fz*t+rz*st;const ml=Math.hypot(mx,mz);if(ml>0){mx/=ml;mz/=ml;}
  const ox=P.x,oz=P.z;
  P.x+=mx*sp*dt;P.z+=mz*sp*dt;
  // sneaking never walks off an edge
  if((P.sneak||P.y>4.5)&&!P.fly&&P.ground&&supportAt(P.x,P.z,P.y)<P.y-0.02){P.x=ox;P.z=oz;}
  pushOut(P);
  const jump=!!(keys.Space||keys.jump);
  if(P.fly){
    P.vy=(jump?MC.flyVert:0)-(P.sneak?MC.flyVert:0);
    P.y+=P.vy*dt;
    const g=supportAt(P.x,P.z,P.y);if(P.y<=g){P.y=g;P.fly=false;P.ground=true;}
  }else{
    if(P.ground&&jump){P.vy=MC.jump;P.ground=false;}
    P.vy=Math.max(P.vy-MC.gravity*dt,-7.84);
    P.y+=P.vy*dt;
    const c=ceilingAt(P.x,P.z,P.y);if(P.y+MC.height>c&&P.vy>0){P.y=c-MC.height;P.vy=0;}
    const g=supportAt(P.x,P.z,Math.max(P.y,P.y-P.vy*dt));
    if(P.y<=g){P.y=g;P.vy=0;P.ground=true;}else P.ground=false;
  }
  const r=Math.hypot(P.x,P.z);if(r>1150){P.x*=1150/r;P.z*=1150/r;}
  P.y=clamp(P.y,0,420);
  const eye=P.y+(P.sneak&&!P.fly?MC.eyeSneak:MC.eye);
  camera.position.set(P.x,eye,P.z);
  camera.rotation.order='YXZ';camera.rotation.set(P.pitch,P.yaw,0);
  const wantFov=MC.fov*(P.sprint?1.1:1)*(window.innerWidth<window.innerHeight?1.12:1);
  camera.fov+=(wantFov-camera.fov)*Math.min(1,dt*10);camera.updateProjectionMatrix();
  cam.tx=P.x;cam.tz=P.z;
  const info=$('#fpInfo');if(info)info.textContent=(P.fly?'비행':P.sneak?'웅크리기':P.sprint?'달리기':'걷기')+' · 고도 '+Math.round(P.y*10)+'m';
}
// ---- UI
const fpUI=$('#fpUI'),coarse=window.matchMedia('(pointer: coarse)').matches;
function enterFP(){
  if(fp)return;fp=true;goal=null;
  let x=cam.tx,z=cam.tz;
  if(Math.hypot(x,z)<18){x=5;z=26;}
  PLAYER.x=x;PLAYER.z=z;PLAYER.y=supportAt(x,z,500);pushOut(PLAYER);PLAYER.y=supportAt(PLAYER.x,PLAYER.z,500);
  PLAYER.yaw=Math.atan2(PLAYER.x,PLAYER.z);PLAYER.pitch=0.25;PLAYER.vy=0;PLAYER.fly=false;PLAYER.ground=true;
  camera.near=0.004;camera.updateProjectionMatrix();
  $('#bar').hidden=true;$('#title').hidden=true;fpUI.hidden=false;fpUI.classList.toggle('touch',coarse);
  document.querySelectorAll('[data-fp]').forEach(b=>b.setAttribute('aria-pressed','true'));
  const hp=$('#fpHelp');hp.style.opacity='1';clearTimeout(enterFP.t);enterFP.t=setTimeout(()=>hp.style.opacity='0',9000);
}
function exitFP(){
  if(!fp)return;if(EL.riding&&EL.state==='idle')exitCab();EL.riding=false;fpUI.classList.remove('riding');fp=false;
  if(document.pointerLockElement)document.exitPointerLock();
  Object.keys(keys).forEach(k=>keys[k]=false);
  cam.tx=PLAYER.x;cam.tz=PLAYER.z;cam.ty=Math.max(PLAYER.y,2);cam.r=40;cam.phi=1.2;cam.theta=PLAYER.yaw;
  camera.near=0.08;camera.rotation.order='XYZ';resize();
  $('#bar').hidden=false;$('#title').hidden=false;fpUI.hidden=true;
  document.querySelectorAll('[data-fp]').forEach(b=>b.setAttribute('aria-pressed','false'));
}
function toggleFP(){fp?exitFP():enterFP();}
document.querySelectorAll('[data-fp]').forEach(b=>b.addEventListener('click',toggleFP));
$('#fpExit').addEventListener('click',exitFP);
{const slower=$('#fpSlower'),faster=$('#fpFaster');
 if(slower)slower.addEventListener('click',()=>setSpeedIdx(speedIdx-1));
 if(faster)faster.addEventListener('click',()=>setSpeedIdx(speedIdx+1));
 setSpeedIdx(speedIdx);}
const TIMES=['day','sunset','night'];
$('#fpTime').addEventListener('click',()=>{const seq=[6.3,12.5,18.15,21.5];let i=0;seq.forEach((h,j)=>{if(Math.abs(h-CLOCK.target)<Math.abs(seq[i]-CLOCK.target))i=j;});CLOCK.play=false;setHour(seq[(i+1)%seq.length]);});
function look(dx,dy,k){PLAYER.yaw-=dx*k;PLAYER.pitch=clamp(PLAYER.pitch-dy*k,-1.553,1.553);}
window.addEventListener('keydown',e=>{
  if(e.code==='F5'||(e.code==='KeyV'&&!e.repeat)){e.preventDefault();toggleFP();return;}
  if(!fp)return;
  if(e.code==='BracketLeft'&&!e.repeat){setSpeedIdx(speedIdx-1);return;}
  if(e.code==='BracketRight'&&!e.repeat){setSpeedIdx(speedIdx+1);return;}
  if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();
  if(!e.repeat){const now=performance.now();
    if(e.code==='Space'){if(now-tapT.space<300)PLAYER.fly=!PLAYER.fly,PLAYER.vy=0;tapT.space=now;}
    if(e.code==='KeyW'){if(now-tapT.w<300)PLAYER.sprint=true;tapT.w=now;}}
  keys[e.code]=true;
});
window.addEventListener('keyup',e=>{keys[e.code]=false;});
window.addEventListener('blur',()=>Object.keys(keys).forEach(k=>keys[k]=false));
// mouse look: pointer lock when allowed, drag-to-look otherwise
let lookId=null,lookLast=null;
canvas.addEventListener('pointerdown',e=>{
  if(!fp)return;
  if(e.pointerType==='mouse'&&canvas.requestPointerLock&&!document.pointerLockElement){try{canvas.requestPointerLock();}catch(err){}}
  lookId=e.pointerId;lookLast={x:e.clientX,y:e.clientY};
});
canvas.addEventListener('pointermove',e=>{
  if(!fp)return;
  if(document.pointerLockElement===canvas){look(e.movementX,e.movementY,0.0022);return;}
  if(e.pointerId!==lookId||!lookLast)return;
  look(e.clientX-lookLast.x,e.clientY-lookLast.y,coarse?0.0055:0.004);lookLast={x:e.clientX,y:e.clientY};
});
const lookEnd=e=>{if(e.pointerId===lookId){lookId=null;lookLast=null;}};
canvas.addEventListener('pointerup',lookEnd);canvas.addEventListener('pointercancel',lookEnd);
// touch buttons (Bedrock-style D-pad + jump / sneak / sprint)
fpUI.querySelectorAll('[data-k]').forEach(b=>{
  const k=b.dataset.k;
  const on=e=>{e.preventDefault();b.setPointerCapture&&b.setPointerCapture(e.pointerId);keys[k]=true;b.classList.add('on');
    if(k==='jump'){const now=performance.now();if(now-tapT.space<300){PLAYER.fly=!PLAYER.fly;PLAYER.vy=0;}tapT.space=now;}
    if(k==='f'){const now=performance.now();if(now-tapT.w<300)PLAYER.sprint=true;tapT.w=now;}};
  const off=e=>{e.preventDefault();keys[k]=false;b.classList.remove('on');};
  b.addEventListener('pointerdown',on);b.addEventListener('pointerup',off);b.addEventListener('pointercancel',off);b.addEventListener('pointerleave',off);
});
fpUI.querySelector('[data-toggle=sneak]').addEventListener('click',e=>{keys.sneak=!keys.sneak;e.currentTarget.classList.toggle('on',keys.sneak);});

/* ===================== Express shuttle (panoramic, on the core face between two wings) ===================== */
/*
  A glass cab runs up the exposed core face at 60°, between wing 0 and wing 1, where it clears both wings.
  Landings bridge from the cab to the wing roofs at every sky lobby and at the rooftop.
  Motion follows a real express-lift profile: 1.2 m/s² acceleration, 18 m/s top speed, doors 0.9 s.
*/
const EL={a:TAU/6,r:4.35,y:0,v:0,stop:0,target:0,state:'idle',door:1,riding:false,ff:false,board:false};
const EL_E=[Math.sin(EL.a),Math.cos(EL.a)],EL_T=[Math.cos(EL.a),-Math.sin(EL.a)];
const STOPS=[{y:0,name:'로비'}];
for(let i=0;i<TOWER.nseg-1;i++)STOPS.push({y:TOWER.y0+i*TOWER.segH+TOWER.segH-TOWER.gap,name:'스카이로비 '+(i+1)});
STOPS.push({y:TOWER.y0+TOWER.nseg*TOWER.segH,name:'전망 옥상'});
const CAB={W:0.28,D:0.26,H:0.3};
const cabMats={
  frame:std({color:0x9aa1a8,metalness:0.9,roughness:0.25}),
  floor:std({color:0x2b2e33,roughness:0.6,metalness:0.2}),
  glass:std({color:0xd8e6ee,metalness:0.9,roughness:0.03,transparent:true,opacity:0.16,depthWrite:false,side:THREE.DoubleSide}),
  light:new THREE.MeshBasicMaterial({color:0xfff2dc}),
  door:std({color:0xb9bfc5,metalness:0.85,roughness:0.3})};
[cabMats.frame,cabMats.floor,cabMats.glass,cabMats.door].forEach(m=>{m.color.convertSRGBToLinear();REFLECTIVE.push(m);});
cabMats.light.color.convertSRGBToLinear();
const cab=new THREE.Group();scene.add(cab);
const doorL=new THREE.Mesh(new THREE.BoxGeometry(CAB.W/2,CAB.H-0.02,0.006),cabMats.door),doorR=doorL.clone();
{const W=CAB.W,D=CAB.D,H=CAB.H,b=(w,h,d,m,x,y,z)=>{const o=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),m);o.position.set(x,y,z);o.castShadow=m!==cabMats.glass;cab.add(o);return o;};
 b(W,0.02,D,cabMats.floor,0,0.01,0);b(W,0.02,D,cabMats.frame,0,H,0);b(W*0.7,0.004,D*0.6,cabMats.light,0,H-0.012,0);
 b(W,H,0.004,cabMats.glass,0,H/2,D/2);[-1,1].forEach(s=>b(0.004,H,D,cabMats.glass,s*W/2,H/2,0));
 [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx,sz])=>b(0.014,H,0.014,cabMats.frame,sx*W/2,H/2,sz*D/2));
 b(W*0.92,0.008,0.008,cabMats.frame,0,0.1,D/2-0.02);
 doorL.position.set(-W/4,H/2,-D/2);doorR.position.set(W/4,H/2,-D/2);cab.add(doorL,doorR);}
cab.rotation.y=EL.a;
function placeCab(){cab.position.set(EL_E[0]*EL.r,EL.y,EL_E[1]*EL.r);const o=CAB.W/4+EL.door*CAB.W/2*0.96;doorL.position.x=-o;doorR.position.x=o;}
placeCab();
// guide rails, machine room, landings with glass guards
{const top=STOPS[STOPS.length-1].y+0.9,rr=EL.r-CAB.D/2-0.03;
 [-1,1].forEach(s=>{const m=new THREE.Mesh(new THREE.BoxGeometry(0.035,top,0.035),M.metal);m.position.set(EL_E[0]*rr+EL_T[0]*s*0.1,top/2,EL_E[1]*rr+EL_T[1]*s*0.1);m.castShadow=true;scene.add(m);});
 const mr=new THREE.Mesh(new THREE.BoxGeometry(0.4,0.35,0.34),M.concrete);mr.position.set(EL_E[0]*EL.r,top+0.1,EL_E[1]*EL.r);mr.rotation.y=EL.a;scene.add(mr);
 const guard=std({color:0xd3e3ec,metalness:0.3,roughness:0.04,transparent:true,opacity:0.18,depthWrite:false});guard.color.convertSRGBToLinear();
 STOPS.forEach((st,i)=>{if(i===0)return;
   const rc=3.475,g=new THREE.Group();g.position.set(EL_E[0]*rc,st.y,EL_E[1]*rc);g.rotation.y=EL.a;scene.add(g);
   const slab=new THREE.Mesh(new THREE.BoxGeometry(4.0,0.06,1.45),M.stone);slab.position.y=-0.03;slab.receiveShadow=true;g.add(slab);
   [-1,1].forEach(s=>{const w=(4.0/2-CAB.W/2-0.03);const p=new THREE.Mesh(new THREE.BoxGeometry(w,0.11,0.01),guard);p.position.set(s*(CAB.W/2+0.03+w/2),0.055,0.72);g.add(p);
     const h=new THREE.Mesh(new THREE.BoxGeometry(w,0.012,0.014),M.metal);h.position.set(s*(CAB.W/2+0.03+w/2),0.115,0.72);g.add(h);});
 });}
function elColliders(add){STOPS.forEach((st,i)=>{if(i===0)return;add({x:EL_E[0]*3.475,z:EL_E[1]*3.475,c:Math.cos(EL.a),s:Math.sin(EL.a),hx:2.0,hz:0.725,y0:st.y-0.06,y1:st.y,round:false,mode:'tower'});});}
elColliders(addCollider);
function nearestStop(y){let b=0;STOPS.forEach((s,i)=>{if(Math.abs(s.y-y)<Math.abs(STOPS[b].y-y))b=i;});return b;}
function sendCab(i){if(i===EL.stop&&EL.state==='idle')return;EL.target=i;if(EL.state==='idle'||EL.state==='opening')EL.state='closing';}
function elStep(dt){
  const t=dt*(EL.ff?6:1);
  if(EL.state==='closing'){EL.door=Math.max(0,EL.door-t/0.9);if(EL.door===0)EL.state=EL.target===EL.stop?'opening':'moving';}
  else if(EL.state==='moving'){
    const ty=STOPS[EL.target].y,rem=Math.abs(ty-EL.y),dir=Math.sign(ty-EL.y),A=0.12,VMAX=1.8;
    if(rem<=EL.v*EL.v/(2*A)+0.002)EL.v=Math.max(0.02,EL.v-A*t);else EL.v=Math.min(VMAX,EL.v+A*t);
    EL.y+=dir*Math.min(rem,EL.v*t);
    if(Math.abs(ty-EL.y)<0.0015){EL.y=ty;EL.v=0;EL.stop=EL.target;EL.state='opening';}
  }else if(EL.state==='opening'){EL.door=Math.min(1,EL.door+t/0.9);if(EL.door===1){EL.state='idle';if(EL.board){EL.board=false;boardCab();}}}
  placeCab();
  // interior light follows the ambient: brighter at night
  cabMats.light.color.setScalar(1).multiplyScalar(0.8+S.glow*0.6);
}
function doorPoint(){return [EL_E[0]*(EL.r-CAB.D/2-0.18),EL_E[1]*(EL.r-CAB.D/2-0.18)];}
function lobbyPortal(){return [EL_E[0]*13.2,EL_E[1]*13.2];}
function canBoard(){
  if(!fp||EL.riding)return -1;
  const P=PLAYER;
  if(P.y<0.6){const [lx,lz]=lobbyPortal();if(Math.hypot(P.x-lx,P.z-lz)<3.2)return 0;
    for(let k=0;k<6;k++){const an=k*TAU/6,px=Math.sin(an)*13.2,pz=Math.cos(an)*13.2;if(Math.hypot(P.x-px,P.z-pz)<2.6)return 0;}return -1;}
  const i=nearestStop(P.y);if(i===0||Math.abs(STOPS[i].y-P.y)>0.25)return -1;
  const [dx,dz]=doorPoint();return Math.hypot(P.x-dx,P.z-dz)<0.9?i:-1;
}
function requestBoard(){const i=canBoard();if(i<0)return;
  if(EL.stop===i&&EL.state==='idle'&&EL.door===1){boardCab();return;}
  EL.board=true;sendCab(i);}
function boardCab(){EL.riding=true;PLAYER.yaw=EL.a+Math.PI;PLAYER.pitch=0.05;fpUI.classList.add('riding');renderStops();}
function exitCab(){
  if(!EL.riding||EL.state!=='idle')return;
  EL.riding=false;fpUI.classList.remove('riding');const P=PLAYER;
  if(EL.stop===0){const [lx,lz]=lobbyPortal();P.x=lx;P.z=lz;P.y=0;P.yaw=EL.a+Math.PI;}
  else{P.x=EL_E[0]*3.6;P.z=EL_E[1]*3.6;P.y=STOPS[EL.stop].y;P.yaw=EL.a-Math.PI/2;}
  P.vy=0;P.fly=false;P.ground=true;P.pitch=0.1;
}
function rideCamera(dt){
  const P=PLAYER;P.x=cab.position.x;P.z=cab.position.z;P.y=EL.y;
  camera.position.set(cab.position.x+EL_E[0]*0.02,EL.y+MC.eye,cab.position.z+EL_E[1]*0.02);
  camera.rotation.order='YXZ';camera.rotation.set(P.pitch,P.yaw,0);
  cam.tx=P.x;cam.tz=P.z;
}
function renderStops(){
  const box=$('#elStops');box.innerHTML='';
  STOPS.forEach((s,i)=>{const b=document.createElement('button');b.textContent=s.name+' · '+Math.round(s.y*10)+'m';b.dataset.stop=i;
    b.setAttribute('aria-pressed',String(i===EL.stop));b.addEventListener('click',()=>{sendCab(i);});box.appendChild(b);});
}
function elHUD(){
  const pr=$('#elPrompt'),pn=$('#elPanel');
  const b=canBoard();pr.hidden=!(b>=0)||EL.riding;
  if(!pr.hidden)$('#elCall').textContent=EL.board?'셔틀 오는 중 · '+Math.round(Math.abs(EL.y-STOPS[b].y)*10)+'m 남음':'셔틀 탑승 (E)';
  pn.hidden=!EL.riding;
  if(EL.riding){
    const dest=STOPS[EL.target].name,alt=Math.round(EL.y*10),sp=(EL.v*10).toFixed(1),fl=Math.round(EL.y*10/4.2);
    $('#elInfo').textContent=(EL.state==='moving'?'→ '+dest:STOPS[EL.stop].name)+' · 고도 '+alt+'m · '+fl+'층 · '+sp+' m/s';
    const idle=EL.state==='idle';$('#elExit').disabled=!idle;$('#elStops').hidden=!idle;$('#elExit').hidden=!idle;
    const inf=$('#fpInfo');if(inf)inf.textContent=idle?'셔틀 정차 중':'셔틀 운행 중';
    document.querySelectorAll('#elStops button').forEach(x=>{x.disabled=!idle;x.setAttribute('aria-pressed',String(+x.dataset.stop===(EL.state==='moving'?EL.target:EL.stop)));});
  }
}
$('#elCall').addEventListener('click',requestBoard);
$('#elExit').addEventListener('click',exitCab);
{const f=$('#elFast');const on=e=>{e.preventDefault();EL.ff=true;f.classList.add('on');},off=()=>{EL.ff=false;f.classList.remove('on');};
 f.addEventListener('pointerdown',on);f.addEventListener('pointerup',off);f.addEventListener('pointerleave',off);f.addEventListener('pointercancel',off);}
window.addEventListener('keydown',e=>{if(!fp)return;if(e.code==='KeyE'&&!e.repeat){EL.riding?exitCab():requestBoard();}if(e.code==='KeyF'&&EL.riding)EL.ff=true;});
window.addEventListener('keyup',e=>{if(e.code==='KeyF')EL.ff=false;});

/* ===================== Section view (built on first use) ===================== */
/*
  A vertical cutting plane through the tower axis, always facing the camera, removes the near half.
  Behind it: floor plates on every storey, core walls with poché, the express/local lift cars moving in
  their shafts, outrigger trusses at each sky lobby, mega columns at the wing tips, and plant floors.
*/
let sectionOn=false,sectionBuilt=false;
const secPlane=new THREE.Plane(new THREE.Vector3(1,0,0),0);
const secGroup=new THREE.Group();secGroup.visible=false;scene.add(secGroup);
const clonePairs=[],secSwaps=[],secCars=[],secLabels=[];
function secMat(o){const m=std(o);m.color.convertSRGBToLinear();if(m.emissive)m.emissive.convertSRGBToLinear();m.clippingPlanes=[secPlane];m.clipShadows=true;REFLECTIVE.push(m);m.envMap=M.metal.envMap;return m;}
function poche(){return new THREE.MeshBasicMaterial({color:new THREE.Color('#2e3338').convertSRGBToLinear(),side:THREE.BackSide,clippingPlanes:[secPlane]});}
function buildSection(){
  sectionBuilt=true;
  const map=new Map();
  const mk=m=>{if(map.has(m))return map.get(m);let c;
    const ghost=(m===M.tower||m===M.core||m===M.mullion||m===M.band||m===M.fin||m===M.louvre||m===M.garden||m===M.skyGlass||m===M.balustrade);
    if(m===M.tower)c=facadeMat(FACADES.tower,{side:THREE.DoubleSide});
    else if(m===M.core)c=facadeMat(FACADES.core,{side:THREE.DoubleSide});
    else{c=m.clone();c.side=THREE.DoubleSide;}
    if(ghost){c.transparent=true;c.opacity=0.13;c.depthWrite=false;c.userData.ghost=true;}
    c.clippingPlanes=[secPlane];c.clipShadows=true;c.envMap=m.envMap;map.set(m,c);clonePairs.push([m,c]);return c;};
  tower.traverse(o=>{if(!o.material||o===secGroup)return;const sm=Array.isArray(o.material)?o.material.map(mk):mk(o.material);secSwaps.push([o,o.material,sm]);});
  const T=TOWER,slabM=secMat({color:'#f2eee6',roughness:0.85,emissive:'#3a3834',emissiveIntensity:0.6}),mechM=secMat({color:'#6f86a0',roughness:0.6,metalness:0.2,transparent:true,opacity:0.55}),
        wallM=secMat({color:'#a3a8ad',roughness:0.8}),steelM=secMat({color:'#e0542c',roughness:0.45,metalness:0.3,emissive:'#6a1d08',emissiveIntensity:0.8}),
        colM=secMat({color:'#bdb6a9',roughness:0.8}),lobbyM=secMat({color:'#e9dcc0',roughness:0.7}),
        carM=secMat({color:'#1c1f24',emissive:'#ffb65c',emissiveIntensity:1.2,roughness:0.5}),expM=secMat({color:'#1c1f24',emissive:'#5cc8ff',emissiveIntensity:1.4,roughness:0.5});
  [steelM,colM,carM,expM].forEach(m=>{m.clippingPlanes=null;});
  const pc=poche(),mm=new THREE.Matrix4(),add=(g,m,x,y,z,ry)=>{const o=new THREE.Mesh(g,m);o.position.set(x||0,y||0,z||0);o.rotation.y=ry||0;secGroup.add(o);return o;};
  for(let i=0;i<T.nseg;i++){
    const yb=T.y0+i*T.segH,last=i===T.nseg-1,hB=last?T.segH:T.segH-T.gap,W=4.6-0.17*i,floors=Math.floor(hB/0.42),mechF=Math.round(floors*0.5);
    const rB=3.6-0.1*i;
    // core walls as a closed hexagonal ring so the cut shows solid poché
    const outer=new THREE.Shape(),hole=new THREE.Path(),ro=rB-0.08,ri=rB-0.45;
    for(let v=0;v<=6;v++){const an=v/6*TAU;(v?outer.lineTo.bind(outer):outer.moveTo.bind(outer))(Math.sin(an)*ro,-Math.cos(an)*ro);}
    for(let v=6;v>=0;v--){const an=v/6*TAU;(v===6?hole.moveTo.bind(hole):hole.lineTo.bind(hole))(Math.sin(an)*ri,-Math.cos(an)*ri);}
    outer.holes.push(hole);
    const cw=new THREE.ExtrudeGeometry(outer,{depth:hB,bevelEnabled:false});cw.rotateX(-Math.PI/2);
    add(cw,wallM,0,yb,0);add(cw,pc,0,yb,0);
    for(let k=0;k<3;k++){
      const a=k*TAU/3,L=wingLen(i,k);
      const plate=wingGeo(W-0.12,L-0.06,0.07),inst=new THREE.InstancedMesh(plate,slabM,floors);let n=0;
      for(let f=1;f<floors;f++){if(f===mechF||f===mechF+1)continue;mm.makeRotationY(a);mm.setPosition(0,yb+f*0.42,0);inst.setMatrixAt(n++,mm);}
      inst.count=n;secGroup.add(inst);
      add(wingGeo(W-0.14,L-0.08,0.8),mechM,0,yb+mechF*0.42,0,a);
      if(!last)add(wingGeo(W-0.1,L-0.05,0.06),lobbyM,0,yb+hB,0,a);
      [-1,1].forEach(s=>{const [cx,cz]=rotXZ(s*(W/2-0.42),L-0.55,a);const cg=new THREE.BoxGeometry(0.34,hB,0.34);add(cg,colM,cx,yb+hB/2,cz,a);add(cg,pc,cx,yb+hB/2,cz,a);});
      if(!last){// outrigger + belt truss through the double-height sky lobby
        const y0=yb+hB+0.05,y1=yb+T.segH-0.05,tip=Math.min(L,wingLen(i+1,k))-0.6,c0=rotXZ(0,rB-0.3,a),c1=rotXZ(0,tip,a);
        const P=(p,y)=>new THREE.Vector3(p[0],y,p[1]);
        [[P(c0,y0),P(c1,y1)],[P(c0,y1),P(c1,y0)],[P(c0,y0),P(c1,y0)],[P(c0,y1),P(c1,y1)]].forEach(([u,v])=>{const s2=dStrut(u,v,0.14);s2.material=steelM;secGroup.add(s2);});
      }
    }
  }
  // lift cars in the core: 3 express shuttles (blue) and 6 locals (amber)
  const carG=new THREE.BoxGeometry(0.34,0.36,0.34);
  for(let j=0;j<9;j++){const an=j/9*TAU+0.2,r=j<3?0.7:1.8,exp=j<3,m=new THREE.Mesh(carG,exp?expM:carM);
    m.position.set(Math.sin(an)*r,rand(2,140),Math.cos(an)*r);secGroup.add(m);
    secCars.push({m:m,y:m.position.y,to:m.position.y,v:0,exp:exp,wait:rand(0,4)});}
  // callouts with leader lines to the element they name: [text, y, side, anchor distance from the axis]
  const segY=i=>T.y0+i*T.segH,mechY=i=>segY(i)+Math.round(Math.floor((T.segH-T.gap)/0.42)*0.5)*0.42+0.4;
  const leadM=new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:0.85,depthTest:false});
  [['익스프레스 셔틀',12,-1,0.7],['코어 벽체',30,1,3.1],['2개 층 기계실',mechY(1),-1,6],['아웃리거 트러스',segY(2)-0.75,1,5],
   ['스카이로비',segY(2)-1.4,-1,6.5],['메가 기둥',segY(3)+6,1,8.5],['전망 옥상 1,500m',150.5,-1,2]].forEach(([t,y,side,d])=>{
    const l=label(t,0,y,0,20,secGroup);l.sprite.material.depthTest=false;
    const g=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]),line=new THREE.Line(g,leadM);line.renderOrder=19;line.frustumCulled=false;secGroup.add(line);
    secLabels.push({sp:l.sprite,y:y,side:side,d:d,line:line});});
}
function setSection(on){
  if(on&&!sectionBuilt)buildSection();
  sectionOn=on;renderer.localClippingEnabled=on;secGroup.visible=on;
  secSwaps.forEach(([o,orig,sec])=>{o.material=on?sec:orig;});
  document.querySelectorAll('[data-section]').forEach(b=>b.setAttribute('aria-pressed',String(on)));
  if(on&&!fp)goal={tx:0,ty:38,tz:0,r:70,phi:1.5,theta:cam.theta};
}
const _fwd=new THREE.Vector3();
function sectionStep(dt){
  camera.getWorldDirection(_fwd);_fwd.y=0;if(_fwd.lengthSq()<1e-6)_fwd.set(0,0,-1);_fwd.normalize();
  secPlane.normal.copy(_fwd);secPlane.constant=0;
  clonePairs.forEach(([o,c])=>{c.emissiveIntensity=c.userData.ghost?0:o.emissiveIntensity;if(!c.userData.ghost)c.opacity=o.opacity;if(c.envMap!==o.envMap)c.envMap=o.envMap;if(o.roughness!==undefined)c.roughness=o.roughness;});
  secCars.forEach(c=>{
    if(c.wait>0){c.wait-=dt;return;}
    if(Math.abs(c.to-c.y)<0.01){c.to=c.exp?(R()<0.5?0.5:STOPS[1+Math.floor(R()*(STOPS.length-1))].y):rand(2,148);c.wait=rand(1,4);return;}
    const d=c.to-c.y,vmax=c.exp?1.8:0.7;c.v=Math.min(vmax,c.v+0.4*dt);if(Math.abs(d)<c.v*c.v/0.8)c.v=Math.max(0.05,c.v-0.8*dt);
    c.y+=Math.sign(d)*Math.min(Math.abs(d),c.v*dt*4);c.m.position.y=c.y;
  });
  const w=clamp(cam.r*0.13,7,60),side=new THREE.Vector3(-_fwd.z,0,_fwd.x),off=4+w*0.55;
  secLabels.forEach(l=>{const lx=side.x*l.side*off,lz=side.z*l.side*off;l.sp.position.set(lx,l.y,lz);l.sp.scale.set(w,w*176/1024,1);
    const p=l.line.geometry.attributes.position;p.setXYZ(0,lx-side.x*l.side*w*0.5,l.y,lz-side.z*l.side*w*0.5);p.setXYZ(1,side.x*l.side*l.d+_fwd.x*0.2,l.y,side.z*l.side*l.d+_fwd.z*0.2);p.needsUpdate=true;});
}

/* ===================== Post-processing ===================== */
await step('화면 효과');
// AO between the buildings, reflections on the wet road, temporal AA — all in
// render/post.js. Falls back to plain forward rendering if the graph refuses
// to compile, so a driver quirk costs effects rather than the whole scene.
let postFX=null;
try{postFX=createPostFX({renderer:renderer,scene:scene,camera:camera,tier:tier});}
catch(e){console.error('post-processing unavailable, rendering forward',e);postFX=null;}

// Surface debug: press S to flood each ground surface with a flat colour, so a
// stray line can be named instead of guessed at. Press again to restore.
{
  const DEBUG_COLS={road:'#3355ff',walk:'#ff3bb0',kerb:'#ffd400',mark:'#00e5ff',yel:'#7CFC00',cross:'#ff6a00'};
  let on=false;const saved=new Map();
  window.addEventListener('keydown',e=>{
    if(e.key!=='s'&&e.key!=='S')return;
    if(e.target&&/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))return;
    if(e.metaKey||e.ctrlKey||e.altKey)return;
    on=!on;
    Object.keys(surfaces).forEach(k=>{
      const mesh=surfaces[k];if(!mesh)return;
      if(on){
        if(!saved.has(k))saved.set(k,mesh.material);
        mesh.material=new THREE.MeshBasicNodeMaterial({color:lin(DEBUG_COLS[k]||'#ffffff')});
      }else if(saved.has(k))mesh.material=saved.get(k);
    });
    console.info(on
      ?'표면 디버그 — 차도:파랑  보도:분홍  연석:노랑  차선:하늘  중앙선:연두  횡단보도:주황'
      :'표면 디버그 해제');
  });
}

/* ===================== UI ===================== */
function press(attr,val){document.querySelectorAll('['+attr+']').forEach(b=>b.setAttribute('aria-pressed',String(b.getAttribute(attr)===val)));}
const PRESET_HOURS={sunrise:6.3,noon:12.5,sunset:18.15,night:21.5};
function setPlay(){const b=$('#play');b.textContent=CLOCK.play?'❚❚':'▶';b.setAttribute('aria-pressed',String(CLOCK.play));b.setAttribute('aria-label',CLOCK.play?'일시정지':'재생');}
document.querySelectorAll('[data-hourp]').forEach(b=>b.addEventListener('click',()=>{CLOCK.play=false;setPlay();setHour(PRESET_HOURS[b.dataset.hourp]);}));
{const hi=$('#hour');hi.addEventListener('input',()=>{CLOCK.play=false;setPlay();setHour(parseFloat(hi.value),true);});}
$('#play').addEventListener('click',()=>{CLOCK.play=!CLOCK.play;setPlay();});
document.querySelectorAll('[data-wx]').forEach(b=>b.addEventListener('click',()=>setWeather(b.dataset.wx)));
document.querySelectorAll('[data-section]').forEach(b=>b.addEventListener('click',()=>{if(fp)return;setSection(!sectionOn);}));
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{const k=b.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));
  document.querySelectorAll('[data-pane]').forEach(p=>p.hidden=p.dataset.pane!==k);}));
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{press('data-view',b.dataset.view);goal=Object.assign({},VIEWS[b.dataset.view]);vT=vP=0;lastInteract=clockT;}));
const cmp=$('#cmp');if(cmp)cmp.addEventListener('click',()=>{const on=cmp.getAttribute('aria-pressed')!=='true';cmp.setAttribute('aria-pressed',String(on));ghosts.visible=on;});
function resize(){const w=window.innerWidth,h=window.innerHeight;renderer.setSize(w,h,false);camera.aspect=w/h;if(!fp)camera.fov=w<h?52:40;camera.updateProjectionMatrix();}
window.addEventListener('resize',resize);resize();

/* ===================== Loop ===================== */
const reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clock=new THREE.Timer();if(clock.connect)clock.connect(document);
const frustum=new THREE.Frustum(),projM=new THREE.Matrix4(),camTarget=new THREE.Vector3();
let shadowSize=0;
function updateShadow(){
  camTarget.set(cam.tx,0,cam.tz);
  const want=clamp(cam.r*0.95,70,560);
  if(Math.abs(want-shadowSize)/Math.max(1,shadowSize)>0.12){
    shadowSize=want;const c=sun.shadow.camera;c.left=-want;c.right=want;c.top=want;c.bottom=-want;c.updateProjectionMatrix();}
  const lean=Math.min(0.45,0.12/Math.max(0.12,lightDir.y));
  camTarget.x-=lightDir.x*want*lean;camTarget.z-=lightDir.z*want*lean;
  sun.position.copy(camTarget).addScaledVector(lightDir,1400);
  sun.target.position.copy(camTarget);sun.target.updateMatrixWorld();
}
let visibleChunks=0;
function cull(){
  projM.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
  // The near and far planes depend on the depth convention, and both of ours
  // changed with the renderer: WebGPU clips z to 0..1 where WebGL used -1..1,
  // and reversed depth swaps the two ends on top of that. Extracting the
  // frustum with the old defaults leaves those planes wrong, which quietly
  // stops the chunk test from rejecting anything — the city renders whole,
  // every frame, and only shows it when you zoom out far enough to see it all.
  frustum.setFromProjectionMatrix(projM,camera.coordinateSystem,camera.reversedDepth===true);
  const camPos=camera.position;
  visibleChunks=0;
  for(let i=0;i<chunkList.length;i++){
    const c=chunkList[i],vis=frustum.intersectsSphere(c.sphere);
    c.group.visible=vis;
    if(vis){visibleChunks++;const d=c.sphere.center.distanceTo(camPos);const det=d<260;for(let j=0;j<c.detail.length;j++)c.detail[j].visible=det;}
  }
}
function loop(ts){
  requestAnimationFrame(loop);
  clock.update(ts);
  const raw=clock.getDelta(),dt=Math.min(raw,0.05);clockT+=dt;
  envStep(Math.min(raw,0.1));
  elStep(dt);
  if(fp){if(EL.riding)rideCamera(dt);else fpStep(dt);elHUD();}
  else if(goal){
    const k=1-Math.exp(-raw*3.2);
    ['tx','ty','tz','r','phi'].forEach(p=>cam[p]+=(goal[p]-cam[p])*k);
    let d=goal.theta-cam.theta;d=Math.atan2(Math.sin(d),Math.cos(d));cam.theta+=d*k;
    if(Math.abs(goal.r-cam.r)<0.3&&Math.abs(d)<0.002&&Math.abs(goal.phi-cam.phi)<0.002)goal=null;
  }else if(pointers.size===0){
    if(Math.abs(panVX)>0.02||Math.abs(panVZ)>0.02){cam.tx+=panVX*dt;cam.tz+=panVZ*dt;const dp=Math.exp(-dt*5.5);panVX*=dp;panVZ*=dp;}
    if(Math.abs(vT)>1e-4||Math.abs(vP)>1e-4){cam.theta+=vT*0.35;cam.phi+=vP*0.35;const dr=Math.exp(-dt*7);vT*=dr;vP*=dr;}
  }
  if(!fp)applyCam();
  {const extra=Math.max(0,cam.r-430);scene.fog.near=S.fogNear+extra;scene.fog.far=S.fogFar+extra;}
  updateShadow();
  sky.position.copy(camera.position);stars.position.copy(camera.position);
  traffic.step(dt,S.traffic>0.01);
  signalStep(dt);
  WATER_N.offset.y+=dt*0.004;WATER_N.offset.x+=dt*0.0015;
  beaconPts.visible=S.street>0.3&&(clockT%1.6)<0.3;beaconPts.material.opacity=1;
  const lab=smooth(700,1100,cam.r);districtLabels.visible=lab>0.01;districtLabels.children.forEach(s=>{s.material.opacity=lab;const w=cam.r*0.13;s.scale.set(w,w*176/1024,1);});
  {const cy=clamp(camera.position.y,0,TOWER.top);towerDetail.visible=Math.hypot(camera.position.x,camera.position.y-cy,camera.position.z)<950;soffitPts.visible=S.garden>0.02&&towerDetail.visible;}
  {// point lights are sized for aerial views; near the ground they shrink to lamp-sized glows
   const k=clamp(camera.position.y/35,0.07,1);
   streetLights.material.size=0.95*k;traffic.groups.forEach(g=>g.material.size=1.5*k);beaconPts.material.size=2.2*Math.max(k,0.2);
   crownPts.material.size=0.42*Math.max(k,0.35);soffitPts.material.size=0.5*Math.max(k,0.3);}
  if(sectionOn)sectionStep(dt);
  cull();
  if(postFX){
    postFX.setBloom(S.bloom,S.bloomThr);
    postFX.setWetness(WX.wet);   // dry roads reflect nothing; SSR fades in with the rain
    postFX.render();
  }
  else renderer.render(scene,camera);
}
const ld=$('#loading');if(ld)ld.hidden=true;$('#bar').hidden=false;
loop();
}
boot().catch(err=>{
  console.error(err);
  if(window.__fail)window.__fail('도시를 짓는 중 문제가 발생했습니다.','새로고침해도 같은 화면이면 아래 내용을 알려 주세요.',String(err&&err.stack||err));
});
