import { readFile } from 'node:fs/promises';
import { configSchema } from '../dist/config.js';
import { INITIAL_SCHEMA, INSPECTION_SCHEMA } from '../dist/storage/schema.js';
import { visibilitySuiteSchema, visibilityRunsSchema } from '../dist/visibility.js';
import { z } from 'zod';
const config =
  JSON.stringify(z.toJSONSchema(configSchema, { unrepresentable: 'any' }), null, 2) + '\n';
const sql =
  '-- Generated from src/storage/schema.ts; run npm run schema:generate.\n' +
  INITIAL_SCHEMA.map((x) => x + ';').join('\n') +
  '\n';
for (const [path, wanted] of [
  ['schemas/config.schema.json', config],
  ['migrations/0001_initial.sql', sql],
  [
    'migrations/0002_url_inspections.sql',
    '-- Generated from src/storage/schema.ts; run npm run schema:generate.\n' +
      INSPECTION_SCHEMA +
      ';\n',
  ],
  ...[
    ['visibility-suite', visibilitySuiteSchema],
    ['visibility-runs', visibilityRunsSchema],
  ].map(([name, schema]) => [
    `schemas/${name}.schema.json`,
    JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any' }), null, 2) + '\n',
  ]),
]) {
  if ((await readFile(new URL('../' + path, import.meta.url), 'utf8')) !== wanted)
    throw Error(
      path + ' is stale. Run npm run build && npm run schema:generate and review the diff.',
    );
}
console.log('Generated configuration schema and D1 migration match the executable source.');
