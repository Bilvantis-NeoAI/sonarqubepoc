const esbuild = require('esbuild');
const isWatch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // vscode: always external
  // jiti: used by eslint's file-based config loader, which we never invoke (we pass inline flat configs)
  // @typescript-eslint/parser + espree: large parsers, kept as runtime requires to avoid bundle bloat
  external: ['vscode', 'jiti', 'jiti/package.json'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  define: { 'process.env.NODE_ENV': '"production"' },
};

if (isWatch) {
  esbuild
    .context(buildOptions)
    .then((ctx) => {
      ctx.watch();
      console.log('[esbuild] watching...');
    })
    .catch(() => process.exit(1));
} else {
  esbuild
    .build(buildOptions)
    .then(() => console.log('[esbuild] build complete'))
    .catch(() => process.exit(1));
}
