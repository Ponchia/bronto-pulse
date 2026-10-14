import type { Resource } from '../config.js';
import { PulseError, invariant } from '../errors.js';
import { array, number, object, text } from '../validation.js';
import { addDays, contains, dateInZone, day, daysBetween } from '../time.js';
import { collected, entry, type CollectContext } from './context.js';
export async function collectNpm(r: Extract<Resource, { provider: 'npm' }>, ctx: CollectContext) {
  const yesterday = addDays(dateInZone(ctx.now), -1),
    to = ctx.window.to > yesterday ? yesterday : ctx.window.to;
  const window = { from: ctx.window.from, to };
  if (window.from > to)
    throw new PulseError(
      'UNAVAILABLE',
      'npm has no completed daily bucket in this requested period.',
    );
  const rows = [];
  for (let from = window.from; from <= to;) {
    const end = addDays(from, 364) < to ? addDays(from, 364) : to;
    const url = `https://api.npmjs.org/downloads/range/${from}:${end}/${encodeURIComponent(r.package)}`;
    const data = object(await ctx.http.json(url));
    invariant(data.package === r.package, 'npm returned a different package identity.');
    invariant(
      data.start === from && data.end === end,
      'npm silently truncated or altered the requested date window.',
    );
    const items = array(data.downloads, 'daily downloads');
    invariant(items.length <= daysBetween(from, end), 'npm returned too many daily buckets.');
    for (const raw of items) {
      const d = object(raw),
        date = day(text(d.day, 'download date'));
      invariant(contains({ from, to: end }, date), 'npm returned an out-of-range date.');
      rows.push(
        entry(
          'npm.downloads',
          date,
          number(d.downloads, 'package downloads', true),
          {},
          date === yesterday ? 'provisional' : 'observed',
          'npm-download-counts-v1',
        ),
      );
    }
    from = addDays(end, 1);
  }
  return collected(window, rows, [
    'Download events include automation and repeats; they are not people.',
    'Yesterday may be revised by the provider. Missing dates are not zero-filled.',
  ]);
}
