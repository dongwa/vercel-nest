import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkgPath = join(process.cwd(), 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const externals = Object.keys(pkg.dependencies || {});

await build({
  entryPoints: ['src/index.ts'],
  format: 'cjs',
  outdir: 'dist',
  platform: 'node',
  bundle: true,
  external: ['@vercel/build-utils', ...externals],
});
