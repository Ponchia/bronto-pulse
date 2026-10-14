#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseConfig, type Config, type Provider } from './config.js';
import { PulseError, safeError } from './errors.js';
import { Store } from './storage/store.js';
import { SqliteDriver } from './storage/sqlite.js';
import { sync, doctor, probe } from './sync.js';
import { projectReport, portfolio, markdownReport } from './report.js';
import { seedDemo } from './demo.js';
import { startServer } from './server.js';
import { addDays, dateInZone, defaultRange, range } from './time.js';

const HELP = `Bronto Pulse 0.1.0 — private project analytics, not a visitor tracker

pulse init                           Create a validated example configuration
pulse validate                       Validate project mappings and credential references
pulse sync [--provider github]       Collect bounded source windows; independent jobs
pulse probe                          Read-only provider capability and permission checks
pulse doctor                         Check coverage, freshness and credential availability
pulse report PROJECT [--days 30]      Source-aware report; --json for agents
pulse compare PROJECT...             Side-by-side reports, never a universal adoption score
pulse export --out private.json      Portable private snapshot; refuses active collectors
pulse import --input private.json    Restore into an EMPTY database, transactionally
pulse annotate --resource ID --title TEXT [--date YYYY-MM-DD]
pulse compact                        Remove old, unreachable staging rows only
pulse serve [--port 4177]             Authenticated read-only UI/API on loopback
pulse demo [--serve]                  Seed deterministic SYNTHETIC data in a separate database

Options: --config FILE (pulse.config.json), --db FILE (.pulse/pulse.db),
 --from YYYY-MM-DD --to YYYY-MM-DD, --resource ID, --group GROUP,
 --max-jobs N --rotate, --json, --out FILE, --input FILE, --port N.
Credentials are read from environment variables named by connections.
No command creates a visitor tracker or publishes your collected data.
`;
const numeric = (v: string | undefined, fallback: number) => {
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new PulseError('CONFIG', 'Numeric option must be a positive integer.');
  return n;
};
async function configFrom(path: string): Promise<Config> {
  try {
    return parseConfig(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error instanceof PulseError) throw error;
    throw new PulseError('CONFIG', 'Cannot read configuration. Run pulse init or pass --config.');
  }
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      db: { type: 'string' },
      json: { type: 'boolean' },
      provider: { type: 'string' },
      resource: { type: 'string' },
      group: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      days: { type: 'string' },
      'max-jobs': { type: 'string' },
      rotate: { type: 'boolean' },
      out: { type: 'string' },
      input: { type: 'string' },
      port: { type: 'string' },
      title: { type: 'string' },
      date: { type: 'string' },
      serve: { type: 'boolean' },
      help: { type: 'boolean' },
      version: { type: 'boolean' },
    },
  });
  const command = positionals[0] ?? 'help';
  if (v.version) {
    console.log('0.1.0');
    return 0;
  }
  if (v.help || command === 'help') {
    console.log(HELP);
    return 0;
  }
  const configPath = resolve(v.config ?? 'pulse.config.json');
  if (command === 'init') {
    const example = await readFile(
      fileURLToPath(new URL('../examples/quickstart.json', import.meta.url)),
      'utf8',
    );
    await writeFile(configPath, example, { flag: 'wx', mode: 0o600 });
    console.log(
      `Created ${configPath}. Review projects, sources and credential references before sync.`,
    );
    return 0;
  }
  const isDemo = command === 'demo';
  const dbPath = resolve(v.db ?? (isDemo ? '.pulse/demo.db' : '.pulse/pulse.db'));
  const store = new Store(new SqliteDriver(dbPath));
  await store.migrate();
  let hold = false;
  try {
    if (command === 'import') {
      if (!v.input)
        throw new PulseError('CONFIG', 'Pass --input FILE to restore a private archive.');
      const raw = await readFile(v.input, 'utf8');
      if (raw.length > 100 * 1024 * 1024)
        throw new PulseError('ROW_LIMIT', 'Archive is too large for bounded JSON import.');
      await store.import(JSON.parse(raw));
      console.log('Import completed atomically into the empty database.');
      return 0;
    }
    let config: Config;
    if (isDemo) {
      config = await seedDemo(store);
      const path = resolve('.pulse/demo.config.json');
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
      console.log(`SYNTHETIC demo data seeded in ${dbPath}. No provider requests were made.`);
      if (!v.serve) {
        console.log(`Open it: pulse serve --config ${path} --db ${dbPath}`);
        return 0;
      }
    } else config = await configFrom(configPath);
    await store.register(config);
    const now = new Date(),
      today = dateInZone(now),
      period = range(v.from ?? addDays(today, -numeric(v.days, 30) + 1), v.to ?? today);
    const print = (value: unknown, text?: string) =>
      console.log(v.json || !text ? JSON.stringify(value, null, 2) : text);
    if (command === 'validate') {
      print(
        { valid: true, projects: config.projects.length, resources: config.resources.length },
        'Configuration is valid; resources, page scopes and effective dates are consistent.',
      );
      return 0;
    }
    if (command === 'sync') {
      if (v.provider && !['github', 'npm', 'cloudflare', 'gsc', 'sense6'].includes(v.provider))
        throw new PulseError('CONFIG', 'Unknown provider.');
      const results = await sync(config, store, process.env, {
        provider: v.provider as Provider | undefined,
        resourceId: v.resource,
        group: v.group,
        window:
          v.from || v.to
            ? range(
                v.from ?? defaultRange(now, config.settings.lookbackDays).from,
                v.to ?? defaultRange(now, config.settings.lookbackDays).to,
              )
            : undefined,
        maxJobs: v['max-jobs'] ? numeric(v['max-jobs'], 1) : undefined,
        rotate: v.rotate,
      });
      print(
        results,
        results
          .map(
            (x) =>
              `${x.status.padEnd(7)} ${x.resourceId}/${x.group}: ${x.rows} rows, ${x.requests} requests${x.code ? ' · ' + x.code + ': ' + x.message : ''}`,
          )
          .join('\n'),
      );
      return results.some((x) => x.status === 'failed') ? 2 : 0;
    }
    if (command === 'probe') {
      const result = await probe(config, process.env, {
        resourceId: v.resource,
        provider: v.provider as Provider | undefined,
      });
      print(result);
      return result.results.some((x) => x.status === 'unavailable') ? 2 : 0;
    }
    if (command === 'doctor') {
      const result = await doctor(config, store, process.env);
      print(
        result,
        result.resources
          .map(
            (x) =>
              `${x.status.padEnd(20)} ${x.resourceId}/${x.group}${x.lastSuccess ? ' last success ' + x.lastSuccess : ''}`,
          )
          .join('\n'),
      );
      return result.healthy ? 0 : 2;
    }
    if (command === 'report') {
      const id = positionals[1];
      if (!id) throw new PulseError('CONFIG', 'Pass a project ID.');
      const result = await projectReport(config, store, id, period);
      print(result, markdownReport(result));
      return 0;
    }
    if (command === 'compare') {
      const ids = positionals.slice(1);
      if (ids.length < 2) throw new PulseError('CONFIG', 'Choose at least two project IDs.');
      const reports = [];
      for (const id of ids) reports.push(await projectReport(config, store, id, period));
      print(
        {
          window: period,
          reports,
          warning: 'Independent source metrics, not an attributed conversion funnel.',
        },
        reports.map(markdownReport).join('\n\n---\n\n'),
      );
      return 0;
    }
    if (command === 'portfolio') {
      print(await portfolio(config, store, period));
      return 0;
    }
    if (command === 'export') {
      if (!v.out)
        throw new PulseError(
          'CONFIG',
          'Use --out FILE for the private export. Store it outside the public repository.',
        );
      await writeFile(v.out, JSON.stringify(await store.export()), { flag: 'wx', mode: 0o600 });
      console.log(
        `Private export written to ${v.out}. It contains collected analytics; it is not a public report.`,
      );
      return 0;
    }
    if (command === 'annotate') {
      if (!v.resource || !v.title)
        throw new PulseError('CONFIG', 'Annotations require --resource and --title.');
      await store.addAnnotation({
        id: crypto.randomUUID(),
        resourceId: v.resource,
        title: v.title,
        date: v.date ?? today,
        kind: 'note',
      });
      console.log('Annotation stored. This marks context, not causal attribution.');
      return 0;
    }
    if (command === 'compact') {
      await store.compact();
      console.log('Unreachable staging rows compacted; active history was not pruned.');
      return 0;
    }
    if (command === 'serve' || (isDemo && v.serve)) {
      const token = process.env.PULSE_API_TOKEN ?? randomBytes(32).toString('hex');
      const server = await startServer(config, store, process.env, {
        port: numeric(v.port, 4177),
        token,
      });
      hold = true;
      if (!process.env.PULSE_API_TOKEN) console.log(`One-session local access token: ${token}`);
      console.log(
        `Private ${config.demo ? 'SYNTHETIC demo' : 'project'} dashboard: http://127.0.0.1:${numeric(v.port, 4177)}`,
      );
      const stop = () =>
        server.close(() => {
          store.driver.close?.();
          process.exit(0);
        });
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      return 0;
    }
    throw new PulseError('CONFIG', 'Unknown command. Run pulse --help.');
  } finally {
    if (!hold) store.driver.close?.();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const clean = safeError(error);
      console.error(`${clean.code}: ${clean.message}`);
      process.exitCode = 1;
    });
}
