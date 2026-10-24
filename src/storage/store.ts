import {
  parseConfig,
  resourceIdentity,
  assertHistoricalMappings,
  type Config,
  type Resource,
} from '../config.js';
import { PulseError, invariant } from '../errors.js';
import {
  canonicalDimensions,
  observationKey,
  type Collected,
  type StoredObservation,
  type Run,
  type Annotation,
  type Observation,
} from '../model.js';
import { days, range, type DateRange, day, dateInZone } from '../time.js';
import { validateCollected } from '../validation.js';
import type { SqlDriver, Statement } from './driver.js';
import { SCHEMA } from './schema.js';
import { validateInspection, type Inspection } from '../inspection.js';

type Row = Record<string, unknown>;
export interface Archive {
  format: 'bronto-pulse';
  version: 1;
  exportedAt: string;
  config: Config;
  resources: Row[];
  runs: Row[];
  partitions: Row[];
  observations: Row[];
  annotations: Row[];
  inspections?: Row[];
}
const json = (v: unknown) => JSON.stringify(v);
async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
function observation(row: Row): StoredObservation {
  return {
    resourceId: String(row.resource_id),
    group: String(row.group_id),
    runId: String(row.run_id),
    collectedAt: String(row.started_at),
    metric: String(row.metric),
    from: String(row.from_day),
    to: String(row.to_day),
    timezone: String(row.timezone),
    kind: row.window_kind as Observation['kind'],
    dimensions: JSON.parse(String(row.dimensions_json)),
    value: Number(row.value),
    numerator: row.numerator === null ? undefined : Number(row.numerator),
    denominator: row.denominator === null ? undefined : Number(row.denominator),
    quality: row.quality as Observation['quality'],
    methodology: String(row.methodology),
  };
}
function run(row: Row): Run {
  return {
    id: String(row.id),
    resourceId: String(row.resource_id),
    group: String(row.group_id),
    from: String(row.from_day),
    to: String(row.to_day),
    status: row.status as Run['status'],
    startedAt: String(row.started_at),
    finishedAt: row.finished_at as string | null,
    rows: Number(row.rows_count),
    requests: Number(row.requests_count),
    code: row.error_code as string | null,
    message: row.error_message as string | null,
    notes: JSON.parse(String(row.notes_json)),
    completeness: row.completeness as Run['completeness'],
  };
}
const OBS_FIELDS = [
  'run_id',
  'item_key',
  'resource_id',
  'group_id',
  'partition_day',
  'metric',
  'from_day',
  'to_day',
  'timezone',
  'window_kind',
  'dimensions_json',
  'value',
  'numerator',
  'denominator',
  'quality',
  'methodology',
];
const RAW_OBS_SELECT = `SELECT o.* FROM observations o JOIN partitions p ON p.run_id=o.run_id AND p.resource_id=o.resource_id AND p.group_id=o.group_id AND p.day=o.partition_day JOIN runs r ON r.id=o.run_id AND r.status='success'`;
export class Store {
  constructor(readonly driver: SqlDriver) {}
  async migrate(): Promise<void> {
    await this.driver.batch(SCHEMA.map((sql) => ({ sql })));
    const version = await this.getSetting('schema_version');
    if (version !== '1') throw new PulseError('SCHEMA', 'Database schema version is unsupported.');
  }
  async getSetting(key: string): Promise<string | undefined> {
    const rows = await this.driver.all({
      sql: 'SELECT value FROM metadata WHERE key=?',
      params: [key],
    });
    return rows[0] ? String(rows[0].value) : undefined;
  }
  async setSetting(key: string, value: string): Promise<void> {
    await this.driver.batch([
      {
        sql: 'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        params: [key, value],
      },
    ]);
  }
  async register(input: Config, now = new Date()): Promise<void> {
    const config = parseConfig(input);
    const raw = json(config);
    // Avoid catalog rewrites on every collection; compare against persisted data,
    // not an isolate-only cache, so a different operator configuration is detected.
    const persisted = await this.getSetting('config');
    if (persisted === raw) return;
    const commands: Statement[] = [];
    const previous = persisted ? parseConfig(JSON.parse(persisted)) : undefined;
    if (previous && previous.demo !== config.demo)
      throw new PulseError('CONFLICT', 'Synthetic and live data must use separate databases.');
    if (
      previous &&
      (
        await this.driver.all({
          sql: 'SELECT day FROM partitions UNION ALL SELECT inspected_at FROM url_inspections LIMIT 1',
        })
      ).length
    ) {
      assertHistoricalMappings(previous, config, dateInZone(now));
      for (const old of previous.resources) {
        const updated = config.resources.find((r) => r.id === old.id);
        if (
          old.provider === 'cloudflare' &&
          updated?.provider === 'cloudflare' &&
          old.hostname !== updated.hostname
        )
          throw new PulseError(
            'CONFLICT',
            'Changing a Cloudflare collection hostname would mix query scopes. Use a new resource ID and dated project mappings.',
          );
      }
    }

    const existing = await this.driver.all({ sql: 'SELECT * FROM resources' });
    if (existing.some((row) => !config.resources.some((r) => r.id === row.id)))
      throw new PulseError(
        'CONFLICT',
        'Resource removal would orphan collected history. Keep the resource with enabled:false instead.',
      );

    for (const r of config.resources) {
      const old = existing.find((x) => x.id === r.id),
        identity = resourceIdentity(r);
      if (
        old &&
        old.identity !== identity &&
        !(
          r.provider === 'github' &&
          r.repositoryId &&
          old.provider_identity === `github:${r.repositoryId}`
        )
      )
        throw new PulseError(
          'CONFLICT',
          `Resource ${r.id} changed identity. Use a new resource ID or pin the verified provider ID.`,
        );
      commands.push({
        sql: 'INSERT INTO resources(id,provider,identity,config_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET identity=excluded.identity,config_json=excluded.config_json',
        params: [r.id, r.provider, identity, json(r)],
      });
    }
    const hash = await digest(raw);
    commands.push(
      {
        sql: 'INSERT OR IGNORE INTO config_versions(hash,created_at,config_json) VALUES(?,?,?)',
        params: [hash, now.toISOString(), raw],
      },
      {
        sql: "INSERT INTO metadata(key,value) VALUES('config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params: [raw],
      },
    );
    await this.driver.batch(commands);
  }
  async getConfig(): Promise<Config | undefined> {
    const value = await this.getSetting('config');
    return value ? parseConfig(JSON.parse(value)) : undefined;
  }
  async acquire(key: string, owner: string, ttlMs = 600000): Promise<boolean> {
    await this.driver.batch([
      {
        sql: 'INSERT INTO leases(key,owner,expires_at) VALUES(?,?,unixepoch()*1000+?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE leases.expires_at<=unixepoch()*1000',
        params: [key, owner, ttlMs],
      },
    ]);
    const rows = await this.driver.all({
      sql: 'SELECT owner FROM leases WHERE key=?',
      params: [key],
    });
    return rows[0]?.owner === owner;
  }
  async release(key: string, owner: string): Promise<void> {
    await this.driver.batch([
      { sql: 'DELETE FROM leases WHERE key=? AND owner=?', params: [key, owner] },
    ]);
  }
  async begin(resource: Resource, group: string, window: DateRange, now: Date): Promise<string> {
    const id = crypto.randomUUID();
    await this.driver.batch([
      {
        sql: 'INSERT INTO runs(id,resource_id,group_id,from_day,to_day,status,started_at) VALUES(?,?,?,?,?,?,?)',
        params: [id, resource.id, group, window.from, window.to, 'running', now.toISOString()],
      },
    ]);
    return id;
  }
  async fail(
    id: string,
    code: string,
    message: string,
    requests: number,
    now: Date,
    status: Run['status'] = 'failed',
  ): Promise<void> {
    await this.driver.batch([
      {
        sql: "UPDATE runs SET status=?,finished_at=?,error_code=?,error_message=?,requests_count=? WHERE id=? AND status='running'",
        params: [status, now.toISOString(), code, message, requests, id],
      },
    ]);
  }
  async publish(
    id: string,
    resource: Resource,
    group: string,
    data: Collected,
    leaseKey: string,
    owner: string,
    requests: number,
    now: Date,
    maxRows: number,
  ): Promise<void> {
    validateCollected(data, resource.provider, maxRows);
    for (const a of data.annotations ?? [])
      invariant(a.resourceId === resource.id, 'Annotation belongs to a different resource.');
    if (data.identity) {
      const old = (
        await this.driver.all({
          sql: 'SELECT provider_identity FROM resources WHERE id=?',
          params: [resource.id],
        })
      )[0];
      if (old?.provider_identity && old.provider_identity !== data.identity)
        throw new PulseError(
          'CONFLICT',
          'The provider resource was replaced or its pinned identity changed. No history was overwritten.',
        );
    }
    // Stage immutable rows under the run ID. They are invisible until partition pointers switch.
    const rows = data.observations.map((o) => ({
      run_id: id,
      item_key: observationKey(o),
      resource_id: resource.id,
      group_id: group,
      partition_day: o.to,
      metric: o.metric,
      from_day: o.from,
      to_day: o.to,
      timezone: o.timezone,
      window_kind: o.kind,
      dimensions_json: canonicalDimensions(o.dimensions),
      value: o.value,
      numerator: o.numerator ?? null,
      denominator: o.denominator ?? null,
      quality: o.quality,
      methodology: o.methodology,
    }));
    for (let i = 0; i < rows.length; i += 100) {
      const values = rows.slice(i, i + 100);
      await this.driver.batch([
        {
          sql: `INSERT INTO observations(${OBS_FIELDS.join(',')}) SELECT ${OBS_FIELDS.map((f) => `json_extract(value,'$.${f}')`).join(',')} FROM json_each(?)`,
          params: [json(values)],
        },
      ]);
    }
    const commands: Statement[] = [
      {
        sql: `UPDATE runs SET status='success',finished_at=?,from_day=?,to_day=?,rows_count=?,requests_count=?,notes_json=?,completeness=? WHERE id=? AND status='running' AND EXISTS(SELECT 1 FROM leases WHERE key=? AND owner=? AND expires_at>unixepoch()*1000)`,
        params: [
          now.toISOString(),
          data.range.from,
          data.range.to,
          rows.length,
          requests,
          json(data.notes),
          data.completeness,
          id,
          leaseKey,
          owner,
        ],
      },
      {
        sql: `INSERT INTO partitions(resource_id,group_id,day,run_id) SELECT ?,?,value,? FROM json_each(?) WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND status='success') ON CONFLICT(resource_id,group_id,day) DO UPDATE SET run_id=excluded.run_id`,
        params: [resource.id, group, id, json(days(data.range)), id],
      },
    ];
    if (data.identity)
      commands.push({
        sql: "UPDATE resources SET provider_identity=? WHERE id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND status='success')",
        params: [data.identity, resource.id, id],
      });
    if (data.annotations?.length)
      commands.push({
        sql: "INSERT INTO annotations(id,resource_id,date,title,url,kind) SELECT json_extract(value,'$.id'),json_extract(value,'$.resourceId'),json_extract(value,'$.date'),json_extract(value,'$.title'),json_extract(value,'$.url'),json_extract(value,'$.kind') FROM json_each(?) WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND status='success') ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url,date=excluded.date",
        params: [json(data.annotations), id],
      });
    await this.driver.batch(commands);
    const state = (
      await this.driver.all({ sql: 'SELECT status FROM runs WHERE id=?', params: [id] })
    )[0]?.status;
    if (state !== 'success')
      throw new PulseError(
        'LEASE_LOST',
        'Collection lease expired or was replaced; staged data was not published.',
      );
  }
  async observations(
    resourceId: string,
    window: DateRange,
    limit = 100000,
  ): Promise<StoredObservation[]> {
    range(window.from, window.to, 3660);
    const rows = await this.driver.all({
      sql: `${RAW_OBS_SELECT.replace('SELECT o.*', 'SELECT o.*,r.started_at')} WHERE o.resource_id=? AND o.partition_day>=? AND o.partition_day<=? ORDER BY o.partition_day,o.metric,o.dimensions_json LIMIT ?`,
      params: [resourceId, window.from, window.to, limit + 1],
    });
    if (rows.length > limit)
      throw new PulseError('ROW_LIMIT', 'Report row budget exceeded. Narrow the date range.');
    return rows.map(observation);
  }
  async runs(limit = 1000, resourceId?: string): Promise<Run[]> {
    return (
      await this.driver.all({
        sql: `SELECT * FROM runs ${resourceId ? 'WHERE resource_id=?' : ''} ORDER BY started_at DESC,rowid DESC LIMIT ?`,
        params: resourceId ? [resourceId, limit] : [limit],
      })
    ).map(run);
  }
  /** Latest state per dataset, independent of total historical run volume. */
  async runHeads(): Promise<{ latest: Run[]; successful: Run[] }> {
    const query = (successful: boolean) => ({
      sql: `SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY resource_id,group_id ORDER BY started_at DESC,rowid DESC) AS rank FROM runs ${successful ? "WHERE status='success'" : ''}) WHERE rank=1`,
    });
    const [latest, successful] = await this.driver.readBatch([query(false), query(true)]);
    return { latest: (latest ?? []).map(run), successful: (successful ?? []).map(run) };
  }
  async observedThrough(): Promise<{ resourceId: string; group: string; date: string }[]> {
    const rows = await this.driver.all({
      sql: `SELECT o.resource_id,o.group_id,MAX(o.partition_day) AS day FROM observations o JOIN partitions p ON p.run_id=o.run_id AND p.resource_id=o.resource_id AND p.group_id=o.group_id AND p.day=o.partition_day JOIN runs r ON r.id=o.run_id AND r.status='success' GROUP BY o.resource_id,o.group_id`,
    });
    return rows.map((r) => ({
      resourceId: String(r.resource_id),
      group: String(r.group_id),
      date: String(r.day),
    }));
  }
  async coverage(
    resourceId: string,
    window: DateRange,
  ): Promise<
    {
      group: string;
      day: string;
      runId: string;
      status: string;
      completeness: string;
      collectedAt: string;
    }[]
  > {
    return (
      await this.driver.all({
        sql: `SELECT p.group_id,p.day,p.run_id,r.status,r.completeness,r.started_at FROM partitions p JOIN runs r ON r.id=p.run_id WHERE p.resource_id=? AND p.day>=? AND p.day<=?`,
        params: [resourceId, window.from, window.to],
      })
    ).map((x) => ({
      group: String(x.group_id),
      day: String(x.day),
      runId: String(x.run_id),
      status: String(x.status),
      completeness: String(x.completeness),
      collectedAt: String(x.started_at),
    }));
  }
  async annotations(resourceIds: string[], window: DateRange): Promise<Annotation[]> {
    if (!resourceIds.length) return [];
    return (
      await this.driver.all({
        sql: 'SELECT * FROM annotations WHERE resource_id IN (SELECT value FROM json_each(?)) AND date>=? AND date<=? ORDER BY date DESC,id',
        params: [json(resourceIds), window.from, window.to],
      })
    ).map((x) => ({
      id: String(x.id),
      resourceId: String(x.resource_id),
      date: String(x.date),
      title: String(x.title),
      url: typeof x.url === 'string' ? x.url : undefined,
      kind: x.kind as Annotation['kind'],
    }));
  }
  async addAnnotation(a: Annotation): Promise<void> {
    day(a.date);
    invariant(
      a.title.length > 0 && a.title.length <= 160 && !/[\u0000-\u001f]/.test(a.title),
      'Invalid annotation title.',
    );
    if (a.url) {
      const u = new URL(a.url);
      invariant(
        ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password,
        'Unsafe annotation URL.',
      );
    }
    invariant(
      (
        await this.driver.all({
          sql: 'SELECT id FROM resources WHERE id=?',
          params: [a.resourceId],
        })
      ).length === 1,
      'Annotation resource is unknown.',
    );
    await this.driver.batch([
      {
        sql: 'INSERT INTO annotations(id,resource_id,date,title,url,kind) VALUES(?,?,?,?,?,?)',
        params: [a.id, a.resourceId, a.date, a.title, a.url ?? null, a.kind],
      },
    ]);
  }
  /** Append normalized attempts atomically. Failed/unknown attempts never overwrite successes. */
  async addInspections(input: Inspection[]): Promise<void> {
    invariant(input.length > 0 && input.length <= 20, 'Invalid inspection write budget.');
    const config = await this.getConfig();
    invariant(config, 'Register configuration before storing inspections.');
    const rows = input.map((row) => {
      const resource = config.resources.find((r) => r.id === row.resourceId);
      invariant(resource, 'Unknown inspection resource.');
      return validateInspection(row, resource);
    });
    await this.driver.batch(
      rows.map((row) => ({
        sql: 'INSERT INTO url_inspections(id,resource_id,url,inspected_at,result_json) VALUES(?,?,?,?,?)',
        params: [row.id, row.resourceId, row.url, row.inspectedAt, json(row)],
      })),
    );
  }
  async inspections(resourceId: string, window: DateRange): Promise<Inspection[]> {
    range(window.from, window.to, 3660);
    const rows = await this.driver.all({
      sql: 'SELECT result_json FROM url_inspections WHERE resource_id=? AND substr(inspected_at,1,10)>=? AND substr(inspected_at,1,10)<=? ORDER BY inspected_at DESC,id LIMIT 10001',
      params: [resourceId, window.from, window.to],
    });
    if (rows.length > 10000)
      throw new PulseError(
        'ROW_LIMIT',
        'Inspection report budget exceeded. Narrow the date range.',
      );
    return rows.map((row) => JSON.parse(String(row.result_json)) as Inspection);
  }
  async export(maxRows = 100000): Promise<Archive> {
    invariant(
      Number.isSafeInteger(maxRows) && maxRows > 0 && maxRows <= 100000,
      'Invalid export row budget.',
    );
    // Read locks, configuration and every table in ONE SQL transaction. Checking
    // leases before separate SELECT calls leaves a race with newly starting jobs.
    const [
      locks = [],
      configRows = [],
      resources = [],
      runs = [],
      partitions = [],
      observations = [],
      annotations = [],
      inspections = [],
    ] = await this.driver.readBatch([
      { sql: 'SELECT key FROM leases WHERE expires_at>unixepoch()*1000' },
      { sql: "SELECT value FROM metadata WHERE key='config'" },
      { sql: 'SELECT * FROM resources' },
      {
        sql: "SELECT * FROM runs WHERE status!='running' AND (id IN (SELECT run_id FROM partitions) OR id IN (SELECT id FROM runs WHERE status!='running' ORDER BY started_at DESC LIMIT 1000)) ORDER BY rowid",
      },
      { sql: 'SELECT * FROM partitions' },
      { sql: RAW_OBS_SELECT + ' LIMIT ?', params: [maxRows + 1] },
      { sql: 'SELECT * FROM annotations' },
      { sql: 'SELECT * FROM url_inspections LIMIT ?', params: [maxRows + 1] },
    ]);
    if (locks.length)
      throw new PulseError('CONFLICT', 'Wait for active collection jobs before exporting.');
    if (!configRows[0]) throw new PulseError('CONFIG', 'No configuration is registered.');
    const config = parseConfig(JSON.parse(String(configRows[0].value)));
    if (observations.length > maxRows || inspections.length > maxRows)
      throw new PulseError(
        'ROW_LIMIT',
        'Export exceeds the bounded row limit. Use an encrypted database backup for a larger installation.',
      );
    // Abandoned running jobs have no published partitions; omit them rather than
    // producing a backup our own importer cannot restore.
    return {
      format: 'bronto-pulse',
      version: 1,
      exportedAt: new Date().toISOString(),
      config,
      resources,
      runs,
      partitions,
      observations,
      annotations,
      inspections,
    };
  }
  async import(input: unknown): Promise<void> {
    const a = input as Archive;
    invariant(a && a.format === 'bronto-pulse' && a.version === 1, 'Unsupported archive format.');
    const config = parseConfig(a.config);
    const inspections = a.inspections === undefined ? [] : a.inspections;
    invariant(
      Array.isArray(inspections) && inspections.length <= 100000,
      'Invalid archived inspection budget.',
    );
    for (const key of ['resources', 'runs', 'partitions', 'observations', 'annotations'] as const)
      invariant(
        Array.isArray(a[key]) && a[key].length <= 100000,
        'Archive table exceeds its import budget.',
      );
    invariant(
      a.resources.length === config.resources.length,
      'Archive catalog does not match the configuration.',
    );
    if ((await this.driver.all({ sql: 'SELECT id FROM resources LIMIT 1' })).length)
      throw new PulseError(
        'CONFLICT',
        'Import requires an empty database; history is never merged implicitly.',
      );
    const resourceIds = new Set(config.resources.map((x) => x.id));
    const runMap = new Map(a.runs.map((x) => [String(x.id), x]));
    invariant(
      new Set(a.resources.map((r) => r.id)).size === a.resources.length,
      'Duplicate archived resource.',
    );
    invariant(runMap.size === a.runs.length, 'Duplicate archived run.');
    for (const row of a.resources) {
      const resource = config.resources.find((r) => r.id === row.id);
      invariant(
        resource &&
          row.provider === resource.provider &&
          row.identity === resourceIdentity(resource),
        'Invalid archived resource identity.',
      );
      invariant(typeof row.config_json === 'string', 'Invalid archived resource configuration.');
      const isolated = parseConfig({
        ...config,
        resources: config.resources.map((r) =>
          r.id === resource.id ? JSON.parse(String(row.config_json)) : r,
        ),
      });
      invariant(
        json(isolated.resources.find((r) => r.id === resource.id)) === json(resource),
        'Archived resource configuration does not match the catalog.',
      );
    }
    for (const row of a.annotations) {
      invariant(
        typeof row.id === 'string' &&
          row.id.length > 0 &&
          row.id.length <= 160 &&
          resourceIds.has(String(row.resource_id)),
        'Invalid archived annotation reference.',
      );
      invariant(
        typeof row.title === 'string' &&
          row.title.length > 0 &&
          row.title.length <= 160 &&
          !/[\u0000-\u001f]/.test(row.title),
        'Invalid archived annotation title.',
      );
      day(String(row.date));
      invariant(['release', 'note'].includes(String(row.kind)), 'Invalid annotation kind.');
      if (row.url !== null && row.url !== undefined) {
        invariant(typeof row.url === 'string' && row.url.length <= 2048, 'Invalid annotation URL.');
        const u = new URL(String(row.url));
        invariant(
          ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password,
          'Unsafe archived annotation URL.',
        );
      }
    }

    for (const row of inspections) {
      const resource = config.resources.find((r) => r.id === row.resource_id);
      invariant(
        resource && typeof row.result_json === 'string',
        'Invalid archived inspection reference.',
      );
      const result = validateInspection(JSON.parse(row.result_json), resource);
      invariant(
        result.id === row.id && result.url === row.url && result.inspectedAt === row.inspected_at,
        'Archived inspection key mismatch.',
      );
    }

    for (const r of a.runs) {
      invariant(
        resourceIds.has(String(r.resource_id)) &&
          ['success', 'failed', 'skipped'].includes(String(r.status)),
        'Invalid run in archive.',
      );
      day(String(r.from_day));
      day(String(r.to_day));
    }
    for (const p of a.partitions) {
      const r = runMap.get(String(p.run_id));
      invariant(
        r && r.status === 'success' && r.resource_id === p.resource_id && r.group_id === p.group_id,
        'Invalid published partition in archive.',
      );
      day(String(p.day));
    }
    for (const raw of a.observations) {
      const r = runMap.get(String(raw.run_id));
      invariant(
        r &&
          r.status === 'success' &&
          r.resource_id === raw.resource_id &&
          r.group_id === raw.group_id,
        'Invalid observation run reference.',
      );
      const obs = observation({ ...raw, started_at: r.started_at });
      const resource = config.resources.find((x) => x.id === raw.resource_id);
      invariant(resource, 'Unknown archived resource.');
      validateCollected(
        {
          observations: [obs],
          range: { from: String(r.from_day), to: String(r.to_day) },
          notes: [],
          completeness: 'complete',
        },
        resource.provider,
        1,
      );
      invariant(
        observationKey(obs) === raw.item_key && raw.partition_day === obs.to,
        'Archive observation key mismatch.',
      );
    }
    // Restore all tables in one atomic driver batch. SQL identifiers below are constants.
    const statements: Statement[] = [];
    const tables: [string, Row[], string[]][] = [
      [
        'resources',
        a.resources,
        ['id', 'provider', 'identity', 'provider_identity', 'config_json'],
      ],
      [
        'runs',
        a.runs,
        [
          'id',
          'resource_id',
          'group_id',
          'from_day',
          'to_day',
          'status',
          'started_at',
          'finished_at',
          'rows_count',
          'requests_count',
          'error_code',
          'error_message',
          'notes_json',
          'completeness',
        ],
      ],
      ['observations', a.observations, OBS_FIELDS],
      ['partitions', a.partitions, ['resource_id', 'group_id', 'day', 'run_id']],
      ['annotations', a.annotations, ['id', 'resource_id', 'date', 'title', 'url', 'kind']],
      ['url_inspections', inspections, ['id', 'resource_id', 'url', 'inspected_at', 'result_json']],
    ];
    for (const [table, rows, fields] of tables) {
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows
          .slice(i, i + 100)
          .map((row) => Object.fromEntries(fields.map((f) => [f, row[f] ?? null])));
        statements.push({
          sql: `INSERT INTO ${table}(${fields.join(',')}) SELECT ${fields.map((f) => `json_extract(value,'$.${f}')`).join(',')} FROM json_each(?)`,
          params: [json(chunk)],
        });
      }
    }
    statements.push({
      sql: "INSERT OR REPLACE INTO metadata(key,value) VALUES('config',?)",
      params: [json(config)],
    });
    await this.driver.batch(statements);
  }
  /** Delete only unreachable staging/replaced observations; never prune active source history. */
  async compact(): Promise<void> {
    await this.driver.batch([
      {
        sql: "DELETE FROM observations WHERE run_id IN (SELECT id FROM runs WHERE julianday(started_at) < julianday('now','-7 days')) AND NOT EXISTS(SELECT 1 FROM partitions p WHERE p.run_id=observations.run_id AND p.resource_id=observations.resource_id AND p.group_id=observations.group_id AND p.day=observations.partition_day)",
      },
      {
        sql: "UPDATE runs SET status='failed',error_code='LEASE_LOST',error_message='Interrupted collection; prior history retained.',finished_at=datetime('now') WHERE status='running' AND julianday(started_at) < julianday('now','-1 day')",
      },
    ]);
  }
}
