import type { Resource } from '../config.js';
import type { Collected } from '../model.js';
import type { CollectContext } from './context.js';
import { collectGithub } from './github.js';
import { collectNpm } from './npm.js';
import { collectCloudflare } from './cloudflare.js';
import { collectGsc } from './gsc.js';
import { collectSense6 } from './sense6.js';
export { groups } from './context.js';
export { probeCloudflare } from './cloudflare.js';
export function collect(r: Resource, group: string, ctx: CollectContext): Promise<Collected> {
  switch (r.provider) {
    case 'github':
      return collectGithub(r, group, ctx);
    case 'npm':
      return collectNpm(r, ctx);
    case 'cloudflare':
      return collectCloudflare(r, group, ctx);
    case 'gsc':
      return collectGsc(r, group, ctx);
    case 'sense6':
      return collectSense6(r, ctx);
  }
}
