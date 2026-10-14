import { writeFile, mkdir } from 'node:fs/promises';
import { configSchema } from '../dist/config.js';
import { z } from 'zod';
import { SCHEMA } from '../dist/storage/schema.js';
await mkdir('schemas', { recursive: true });
await mkdir('migrations', { recursive: true });
await writeFile(
  'schemas/config.schema.json',
  JSON.stringify(z.toJSONSchema(configSchema, { unrepresentable: 'any' }), null, 2) + '\n',
);
await writeFile(
  'migrations/0001_initial.sql',
  '-- Generated from src/storage/schema.ts; run npm run schema:generate.\n' +
    SCHEMA.map((x) => x + ';').join('\n') +
    '\n',
);
console.log('Configuration JSON Schema and D1 migration regenerated.');
