import test from 'node:test';
import assert from 'node:assert/strict';
import { csvReport } from '../src/report-export.js';
import { projectReport } from '../src/report.js';
import { database, fixture, publish, sample, now, window } from './helpers.js';
import { parseConfig } from '../src/config.js';

// Small quoted-cell parser for tests: preserves embedded delimiters and newlines.
function rows(csv: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]!;
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(value);
      value = '';
    } else if (char === '\r' && !quoted && csv[i + 1] === '\n') {
      row.push(value);
      result.push(row);
      row = [];
      value = '';
      i++;
    } else value += char;
  }
  assert.equal(quoted, false);
  return result;
}
for (const demo of [false, true]) {
  test(`CSV preserves source-series identity and ${demo ? 'synthetic' : 'collected'} provenance`, async () => {
    const config = parseConfig({ ...fixture(), demo });
    const store = await database(config);
    try {
      await publish(store, config, [sample('2026-10-12', 0), sample('2026-10-13', 8)]);
      const report = await projectReport(config, store, 'project', window, now);
      const [head, ...records] = rows(csvReport(report));
      assert.ok(head);
      assert.deepEqual(head.slice(0, 3), ['project', 'resource', 'metric']);
      for (const row of records) {
        assert.equal(row.length, head.length);
        const out = Object.fromEntries(head.map((key, i) => [key, row[i]]));
        const card = report.cards.find((c) => c.key === out.series_key);
        assert.ok(card, 'exported row must resolve to its exact source series');
        assert.equal(out.provider, card.provider);
        assert.deepEqual(JSON.parse(out.dimensions!), card.dimensions);
        assert.equal(out.data_kind, demo ? 'synthetic' : 'collected');
        assert.equal(out.generated_at, report.generatedAt);
        assert.equal(out.latest_collected_at, card.latestCollectedAt ?? '');
        assert.equal(out.baseline_from, card.comparison.baselinePeriod?.from ?? '');
        assert.equal(out.baseline_to, card.comparison.baselinePeriod?.to ?? '');
        assert.equal(out.relative_change, card.comparison.relativeChange?.toString() ?? '');
        assert.deepEqual(JSON.parse(out.report_warnings!), report.warnings);
        assert.equal(out.value, card.value?.toString() ?? '');
      }
    } finally {
      store.driver.close?.();
    }
  });
}
