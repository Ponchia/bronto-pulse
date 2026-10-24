import { writeFile, mkdir } from 'node:fs/promises';
import { configSchema } from '../dist/config.js';
import { z } from 'zod';
import { INITIAL_SCHEMA, INSPECTION_SCHEMA } from '../dist/storage/schema.js';
import { visibilitySuiteSchema, visibilityRunsSchema } from '../dist/visibility.js';
await mkdir('schemas', { recursive: true });
await mkdir('migrations', { recursive: true });
await writeFile(
  'schemas/config.schema.json',
  JSON.stringify(z.toJSONSchema(configSchema, { unrepresentable: 'any' }), null, 2) + '\n',
);
await writeFile(
  'migrations/0001_initial.sql',
  '-- Generated from src/storage/schema.ts; run npm run schema:generate.\n' +
    INITIAL_SCHEMA.map((x) => x + ';').join('\n') +
    '\n',
);
await writeFile(
  'migrations/0002_url_inspections.sql',
  '-- Generated from src/storage/schema.ts; run npm run schema:generate.\n' +
    INSPECTION_SCHEMA +
    ';\n',
);
console.log('Configuration JSON Schema and D1 migration regenerated.');
for (const [name, schema] of [
  ['visibility-suite', visibilitySuiteSchema],
  ['visibility-runs', visibilityRunsSchema],
])
  await writeFile(
    `schemas/${name}.schema.json`,
    JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any' }), null, 2) + '\n',
  );
