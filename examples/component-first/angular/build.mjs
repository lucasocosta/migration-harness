import { build } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['main.ts'], outfile: 'dist/app.js', bundle: true, format: 'iife', platform: 'browser', target: 'es2016', logLevel: 'silent',
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } } });
await copyFile('design-system.css', 'dist/styles.css');
await writeFile('dist/index.html', '<!doctype html><html lang="pt-BR"><title>Angular component-first</title><link rel="stylesheet" href="/styles.css"><harness-root></harness-root><script src="/app.js"></script></html>');
