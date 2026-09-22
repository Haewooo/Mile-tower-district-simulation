/**
 * Build pipeline.
 *
 *   node build.mjs vendor          bundle three.js + TSL post-processing nodes -> vendor/
 *   node build.mjs app             bundle src/main.js -> dist/
 *   node build.mjs vendor app      both
 *   node build.mjs app --watch     rebuild on change
 *   node build.mjs app --watch --serve   ... and serve on :8000
 *
 * The vendor bundle changes only when three.js is upgraded, so it is built
 * separately and committed; the app bundle is rebuilt constantly.
 */
import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const argv = process.argv.slice(2);
const targets = argv.filter(a => !a.startsWith('--'));
const watch = argv.includes('--watch');
const serve = argv.includes('--serve');
const root = import.meta.dirname;

const shared = {
  bundle: true,
  format: 'esm',
  target: ['es2022', 'chrome120', 'firefox121', 'safari17'],
  legalComments: 'none',
  logLevel: 'info',
};

/** three.js + the TSL nodes the app uses, as one ES module. */
const vendorConfig = {
  ...shared,
  entryPoints: [path.join(root, 'vendor/vendor-entry.js')],
  outfile: path.join(root, 'vendor/three.bundle.min.js'),
  minify: true,
};

/**
 * Keep three.js out of the app bundle.
 *
 * Modules reach the vendor bundle by different relative paths depending on how
 * deep they sit, so esbuild's `external` list — which matches import strings
 * literally — misses all but the shallowest. This catches them by suffix and
 * rewrites every one to the single path that is correct from dist/, so the
 * browser fetches three once and caches it across app rebuilds.
 */
const externalVendor = {
  name: 'external-vendor',
  setup(build) {
    build.onResolve({ filter: /vendor\/three\.bundle\.min\.js$/ }, () => ({
      path: '../vendor/three.bundle.min.js',
      external: true,
    }));
  },
};

/** The application itself. */
const appConfig = {
  ...shared,
  entryPoints: [path.join(root, 'src/main.js')],
  outfile: path.join(root, 'dist/app.js'),
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  plugins: [externalVendor],
  loader: { '.css': 'text', '.glsl': 'text' },
};

function kb(n) { return (n / 1024).toFixed(0) + 'K'; }

async function report(label, file) {
  if (!existsSync(file)) return;
  const buf = await readFile(file);
  const { gzipSync } = await import('node:zlib');
  console.log(`  ${label.padEnd(10)} ${kb(buf.length).padStart(6)}  gzip ${kb(gzipSync(buf).length).padStart(6)}`);
}

async function run(name, config) {
  await mkdir(path.dirname(config.outfile), { recursive: true });
  if (watch && name === 'app') {
    const ctx = await esbuild.context(config);
    await ctx.watch();
    console.log(`watching src/ -> ${path.relative(root, config.outfile)}`);
  } else {
    await esbuild.build(config);
    await report(name, config.outfile);
  }
}

if (targets.includes('vendor')) await run('vendor', vendorConfig);
if (targets.includes('app')) await run('app', appConfig);
if (targets.length === 0) { console.error('nothing to build: pass "vendor" and/or "app"'); process.exit(1); }

if (serve) {
  const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
                  '.exr':'image/aces', '.jpg':'image/jpeg', '.png':'image/png', '.md':'text/markdown' };
  http.createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
                           'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  }).listen(8000, () => console.log('serving http://localhost:8000'));
}
