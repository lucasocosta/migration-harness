/**
 * Reporter de eventos do `node --test` usado por `scripts/run-tests.mjs`.
 *
 * Faz duas coisas ao mesmo tempo: (1) reemite o TAP padrão para o stdout (via `node:test/reporters`)
 * e (2) grava em `TEST_EVENTS_FILE` (env) um resumo estruturado `{ summary, skips }`, onde cada
 * skip carrega `{file, name, skip}`. O TAP sozinho não diz de que arquivo veio um skip; o evento
 * do reporter diz. Skips sintéticos de `--test-name-pattern` ("test name does not match pattern")
 * são descartados: não são skips de verdade.
 */
import { writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tap } from 'node:test/reporters';

const PATTERN_SKIP = 'test name does not match pattern';

export default async function* reporter(source) {
  const events = [];
  const summary = {};
  const skips = [];
  for await (const event of source) {
    events.push(event);
    if (event.type === 'test:diagnostic') {
      const match = /^([a-z_]+) (\d+)$/.exec(event.data.message);
      if (match) summary[match[1]] = Number(match[2]);
    }
    if ((event.type === 'test:pass' || event.type === 'test:fail') && event.data.skip !== undefined
      && event.data.skip !== PATTERN_SKIP) {
      skips.push({ file: event.data.file, name: event.data.name, skip: event.data.skip });
    }
  }
  if (process.env.TEST_EVENTS_FILE) writeFileSync(process.env.TEST_EVENTS_FILE, JSON.stringify({ summary, skips }));
  for await (const chunk of Readable.from(events).compose(tap)) yield chunk;
}
