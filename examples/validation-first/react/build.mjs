import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['App.tsx'], outfile: 'dist/app.js', bundle: true, format: 'iife', platform: 'browser', target: 'es2016', logLevel: 'silent' });
await writeFile('dist/index.html', '<!doctype html><html lang="en"><title>Existing React</title><harness-root></harness-root><script src="/app.js"></script></html>');
