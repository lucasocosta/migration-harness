import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EquivalenceValidator } from '../packages/equivalence-validator/dist/index.js';

const [sourcePath, targetPath, outputPath] = process.argv.slice(2);
if (!sourcePath || !targetPath || !outputPath) {
  console.error('usage: node scripts/validate-e2e.mjs <source> <target> <out>');
  process.exit(2);
}
const source = JSON.parse(await readFile(sourcePath, 'utf8'));
const target = JSON.parse(await readFile(targetPath, 'utf8'));
const validator = new EquivalenceValidator();
const result = validator.validate({
  source,
  target,
  policy: {
    network: {
      pathTemplateRules: [{ pattern: /^\/api\/customers\/[^/]+$/, template: '/api/customers/:id' }],
      comparePayloadShape: true,
      compareStatusCode: true,
    }
  }
});
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === 'EQUIVALENT' ? 0 : 4);
