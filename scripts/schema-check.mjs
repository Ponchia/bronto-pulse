import { readFile } from 'node:fs/promises';
import { configSchema } from '../dist/config.js';
import { SCHEMA } from '../dist/storage/schema.js';
import { z } from 'zod';
const config =
  JSON.stringify(z.toJSONSchema(configSchema, { unrepresentable: 'any' }), null, 2) + '\n';
const sql =
  '-- Generated from src/storage/schema.ts; run npm run schema:generate.\n' +
  SCHEMA.map((x) => x + ';').join('\n') +
  '\n';
for (const [path, wanted] of [
  ['schemas/config.schema.json', config],
  ['migrations/0001_initial.sql', sql],
]) {
  if ((await readFile(new URL('../' + path, import.meta.url), 'utf8')) !== wanted)
    throw Error(
      path + ' is stale. Run npm run build && npm run schema:generate and review the diff.',
    );
}
console.log('Generated configuration schema and D1 migration match the executable source.');
