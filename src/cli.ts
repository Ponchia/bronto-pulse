#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
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
import { dateInZone, reportRange } from './time.js';
import { planCollection, markdownPlan } from './plan.js';
import { projectBrief, markdownBrief } from './brief.js';
import { csvReport } from './report-export.js';
import { visibilityCli, privateJson } from './visibility-cli.js';
import { inspectUrls } from './inspection.js';

// The package manifest is the one version source for a checkout and the published archive.
const VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const HELP = `Bronto Pulse ${VERSION} — private project analytics, not a visitor tracker

pulse init                           Create a validated example configuration
pulse validate                       Validate project mappings and credential references
pulse plan [--from DATE --to DATE]   Offline, bounded collection plan; no DB or API access
pulse sync [--provider github]       Collect bounded source windows; --dry-run previews
pulse backfill --from DATE --to DATE Collect planned chunks with an explicit job budget
pulse probe                          Read-only provider capability and permission checks
pulse inspect --resource ID --input FILE  Inspect an explicit JSON list of 1–20 GSC URLs
pulse visibility template|report|promptfoo  Offline benchmark; --suite FILE, --session FILE or --input FILE
pulse doctor                         Check coverage, freshness and credential availability
pulse report PROJECT [--days 30]      Source-aware report; --format json|markdown|csv
pulse brief [PROJECT]                Evidence-based summary; omitting ID covers portfolio
pulse compare PROJECT...             Side-by-side reports, never a universal adoption score
pulse export --out private.json      Portable private snapshot; refuses active collectors
pulse import --input private.json    Restore into an EMPTY database, transactionally
pulse annotate --resource ID --title TEXT [--date YYYY-MM-DD]
pulse compact                        Remove old, unreachable staging rows only
pulse serve [--port 4177]             Authenticated read-only UI/API on loopback
pulse demo [--serve]                  Seed deterministic SYNTHETIC data in a separate database

Options: --config FILE (pulse.config.json), --db FILE (.pulse/pulse.db),
 --from YYYY-MM-DD --to YYYY-MM-DD, --resource ID, --group GROUP,
 --max-jobs N --chunk-days N --rotate --dry-run, --json, --format FORMAT,
 --out FILE (exclusive private output), --input FILE, --port N.
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
      'dry-run': { type: 'boolean' },
      'chunk-days': { type: 'string' },
      format: { type: 'string' },
      out: { type: 'string' },
      input: { type: 'string' },
      suite: { type: 'string' },
      session: { type: 'string' },
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
    console.log(VERSION);
    return 0;
  }
  if (v.help || command === 'help') {
    console.log(HELP);
    return 0;
  }
  const known = new Set([
    'init',
    'validate',
    'plan',
    'sync',
    'backfill',
    'probe',
    'doctor',
    'report',
    'brief',
    'compare',
    'portfolio',
    'export',
    'import',
    'annotate',
    'compact',
    'serve',
    'demo',
    'inspect',
    'visibility',
  ]);
  if (!known.has(command)) throw new PulseError('CONFIG', 'Unknown command. Run pulse --help.');
  if (v.format && !['json', 'markdown', 'csv'].includes(v.format))
    throw new PulseError('CONFIG', 'Output format must be json, markdown or csv.');
  if (v.json && v.format && v.format !== 'json')
    throw new PulseError('CONFIG', '--json conflicts with the selected output format.');
  if (v.format && !['report', 'brief'].includes(command))
    throw new PulseError('CONFIG', '--format applies only to report and brief.');
  if (command === 'brief' && v.format === 'csv')
    throw new PulseError(
      'CONFIG',
      'Brief supports json or markdown. Use report --format csv for metric rows.',
    );
  if (v['dry-run'] && !['sync', 'backfill'].includes(command))
    throw new PulseError(
      'CONFIG',
      '--dry-run applies to sync or backfill; plan is always read-only.',
    );
  if (v['chunk-days'] && !['plan', 'backfill'].includes(command))
    throw new PulseError('CONFIG', '--chunk-days applies only to plan or backfill.');
  const now = new Date();
  const selection = {
    provider: v.provider as Provider | undefined,
    resourceId: v.resource,
    group: v.group,
  };
  const planOptions = {
    ...selection,
    now,
    window:
      v.from || v.to
        ? reportRange({ from: v.from, to: v.to, days: numeric(v.days, 14) }, now)
        : undefined,
    chunkDays: v['chunk-days'] ? numeric(v['chunk-days'], 7) : undefined,
    maxJobs: v['max-jobs'] ? numeric(v['max-jobs'], 64) : undefined,
  };
  const plannedOptions = (config: Config) => ({
    ...planOptions,
    window:
      v.from || v.to || v.days
        ? reportRange(
            { from: v.from, to: v.to, days: numeric(v.days, config.settings.lookbackDays) },
            now,
          )
        : undefined,
  });
  if (v.out && !['report', 'brief', 'export', 'inspect', 'visibility'].includes(command))
    throw new PulseError(
      'CONFIG',
      '--out applies to report, brief, export, inspect or visibility.',
    );
  if (command === 'visibility') return visibilityCli(positionals[1], v);
  const configPath = resolve(v.config ?? 'pulse.config.json');
  if (command === 'probe') {
    const config = await configFrom(configPath);
    const result = await probe(config, process.env, {
      ...selection,
      now,
      maxJobs: planOptions.maxJobs,
    });
    console.log(JSON.stringify(result, null, 2));
    return result.omittedJobs || result.results.some((x) => x.status === 'unavailable') ? 2 : 0;
  }

  if (command === 'plan' || command === 'validate' || v['dry-run']) {
    const config = await configFrom(configPath);
    if (v.rotate && v['dry-run'])
      throw new PulseError(
        'CONFIG',
        'Offline planning does not read the rotation cursor. Omit --rotate to preview date jobs.',
      );
    const result =
      command === 'validate'
        ? { valid: true, projects: config.projects.length, resources: config.resources.length }
        : planCollection(config, {
            ...plannedOptions(config),
            chunkDays: command === 'sync' ? 366 : planOptions.chunkDays,
          });
    console.log(
      v.json
        ? JSON.stringify(result, null, 2)
        : 'jobs' in result
          ? markdownPlan(result)
          : 'Configuration is valid; no database or provider connection was opened.',
    );
    return 0;
  }

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
    if (command === 'inspect') {
      if (!v.resource)
        throw new PulseError('CONFIG', 'Inspection requires --resource ID and --input FILE.');
      const input = await privateJson(v.input, 65536);
      if (!Array.isArray(input) || input.some((url) => typeof url !== 'string'))
        throw new PulseError('CONFIG', 'Inspection input must be a JSON array of URL strings.');
      const results = await inspectUrls(config, v.resource, input, process.env);
      await store.addInspections(results);
      const output =
        JSON.stringify({ schemaVersion: 1, resourceId: v.resource, results }, null, 2) + '\n';
      if (v.out) await writeFile(v.out, output, { flag: 'wx', mode: 0o600 });
      else console.log(output);
      return results.some((row) => row.status !== 'observed') ? 2 : 0;
    }
    const today = dateInZone(now),
      period = reportRange({ from: v.from, to: v.to, days: numeric(v.days, 30) }, now);
    const emit = async (value: unknown, text: string, format = 'markdown') => {
      const output =
        v.json || v.format === 'json' || format === 'json'
          ? JSON.stringify(value, null, 2) + '\n'
          : text;
      if (v.out) {
        await writeFile(v.out, output, { flag: 'wx', mode: 0o600 });
        console.log('Private report written without overwriting any existing file.');
      } else console.log(output);
    };
    const print = (value: unknown, text?: string) =>
      console.log(v.json || !text ? JSON.stringify(value, null, 2) : text);
    if (command === 'sync') {
      if (v.provider && !['github', 'npm', 'cloudflare', 'gsc', 'sense6'].includes(v.provider))
        throw new PulseError('CONFIG', 'Unknown provider.');
      const results = await sync(config, store, process.env, {
        provider: v.provider as Provider | undefined,
        resourceId: v.resource,
        group: v.group,
        window: plannedOptions(config).window,
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
    if (command === 'backfill') {
      if (!v.from || !v.to)
        throw new PulseError(
          'CONFIG',
          'Backfill requires both --from and --to. Review pulse plan first.',
        );
      const plan = planCollection(config, plannedOptions(config));
      if (plan.omittedJobs)
        throw new PulseError(
          'ROW_LIMIT',
          'Backfill plan exceeds the job budget. Narrow the selection or explicitly raise --max-jobs; no provider requests were made.',
        );
      if (!plan.jobs.length)
        throw new PulseError('UNAVAILABLE', 'No provider-retrievable dates remain in this plan.');
      const results = [];
      for (const job of plan.jobs)
        results.push(
          ...(await sync(config, store, process.env, {
            resourceId: job.resourceId,
            group: job.group,
            window: job.window,
            now,
          })),
        );
      print({ plan, results });
      return results.some((r) => r.status === 'failed') ? 2 : 0;
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
      await emit(result, v.format === 'csv' ? csvReport(result) : markdownReport(result));
      return 0;
    }
    if (command === 'brief') {
      const ids = positionals[1] ? [positionals[1]] : config.projects.map((p) => p.id);
      const briefs = [];
      for (const id of ids)
        briefs.push(projectBrief(await projectReport(config, store, id, period, now)));
      await emit(
        positionals[1]
          ? briefs[0]
          : { schemaVersion: 1, demo: config.demo, window: period, briefs },
        briefs.map(markdownBrief).join('\n---\n'),
      );
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
      const configuredToken = process.env.PULSE_API_TOKEN;
      // Keep the displayable, newly generated local token separate from the
      // operator-provided secret. Never send configured credentials to output.
      const localToken =
        configuredToken === undefined ? randomBytes(32).toString('hex') : undefined;
      const token = configuredToken ?? localToken!;
      const server = await startServer(config, store, process.env, {
        port: numeric(v.port, 4177),
        token,
      });
      hold = true;
      if (localToken !== undefined) console.log(`One-session local access token: ${localToken}`);
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
// npm installs the CLI as a node_modules/.bin symlink, so compare real paths:
// a resolved symlink path never equals this module and the CLI would exit silently.
const invokedDirectly = (argv1: string | undefined): boolean => {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (invokedDirectly(process.argv[1])) {
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
