// Bundle everything — the Feishu SDK included — into one self-contained file,
// so `npx skills add` gives a copy that runs with no `npm install` and no
// build step on the user's machine. That is the whole point: a skill someone
// has to build before trying is a skill most people never try.
import { build } from 'esbuild';
import { chmodSync, mkdirSync } from 'node:fs';

// Dependencies of the Feishu SDK are CommonJS and reach for `__dirname` /
// `require`, which do not exist in an ES module. Reconstruct them at the top
// of the bundle.
const banner = [
  "import{createRequire as __cr}from'node:module';",
  "import{fileURLToPath as __f2p}from'node:url';",
  "import{dirname as __dn}from'node:path';",
  'const require=__cr(import.meta.url);',
  'const __filename=__f2p(import.meta.url);',
  'const __dirname=__dn(__filename);',
].join('');

mkdirSync('dist', { recursive: true });

const result = await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: true,
  // `.mjs`, not `.js`: the file must be read as an ES module even when it is
  // copied somewhere without a `"type": "module"` package.json beside it.
  // esbuild hoists the entry's own shebang, so the banner must not add one.
  outfile: 'dist/cli.mjs',
  banner: { js: banner },
  metafile: true,
  logLevel: 'warning',
});

chmodSync('dist/cli.mjs', 0o755);
const bytes = Object.values(result.metafile.outputs)[0].bytes;
console.log(`dist/cli.mjs  ${(bytes / 1024 / 1024).toFixed(1)} MB  (self-contained, no node_modules needed)`);
