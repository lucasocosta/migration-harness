import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['main.ts'], outfile: 'dist/app.js', bundle: true, format: 'iife', platform: 'browser', target: 'es2016', logLevel: 'silent',
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } } });
await writeFile('dist/index.html', '<!doctype html><html lang="en"><title>Angular profile</title><harness-root></harness-root><script src="/app.js"></script></html>');
