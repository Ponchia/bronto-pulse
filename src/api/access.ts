import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { PulseError } from '../errors.js';
import type { Fetcher } from '../http.js';

export interface AccessSettings {
  team: string;
  audience: string;
  hostname: string;
  emails: readonly string[];
}
export interface AccessEnvironment {
  PULSE_AUTH_MODE?: string;
  PULSE_ACCESS_TEAM?: string;
  PULSE_ACCESS_AUD?: string;
  PULSE_ACCESS_HOSTNAME?: string;
  PULSE_ACCESS_EMAILS?: string;
}
export type AccessAuthorizer = (request: Request, now: Date) => Promise<boolean>;

/** Public, operator-pinned identity settings, never derived from an incoming JWT. */
export function accessSettings(env: AccessEnvironment): AccessSettings | undefined {
  const fields = [
    env.PULSE_ACCESS_TEAM,
    env.PULSE_ACCESS_AUD,
    env.PULSE_ACCESS_HOSTNAME,
    env.PULSE_ACCESS_EMAILS,
  ];
  if (env.PULSE_AUTH_MODE === undefined && fields.every((x) => x === undefined)) return undefined;
  const emails = (env.PULSE_ACCESS_EMAILS ?? '').split(',').map((x) => x.trim().toLowerCase());
  if (
    env.PULSE_AUTH_MODE !== 'access' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(
      env.PULSE_ACCESS_TEAM ?? '',
    ) ||
    !/^[a-f0-9]{64}$/.test(env.PULSE_ACCESS_AUD ?? '') ||
    !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(env.PULSE_ACCESS_HOSTNAME ?? '') ||
    emails.length < 1 ||
    emails.length > 16 ||
    emails.some((x) => x.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))
  )
    throw new PulseError(
      'CONFIG',
      'Cloudflare Access authentication settings are incomplete or invalid.',
    );
  return {
    team: env.PULSE_ACCESS_TEAM!,
    audience: env.PULSE_ACCESS_AUD!,
    hostname: env.PULSE_ACCESS_HOSTNAME!,
    emails: [...new Set(emails)],
  };
}

export function createAccessAuthorizer(
  settings: AccessSettings,
  fetcher: Fetcher = (url, init) => fetch(url, init),
): AccessAuthorizer {
  const issuer = `https://${settings.team}`;
  const certs = new URL('/cdn-cgi/access/certs', issuer);
  const jwks = createRemoteJWKSet(certs, {
    timeoutDuration: 5000,
    cooldownDuration: 30000,
    cacheMaxAge: 600000,
    [customFetch]: async (url, options) => {
      if (String(url) !== certs.href) throw new Error('Unexpected identity key endpoint.');
      const response = await fetcher(certs.href, {
        ...options,
        redirect: 'manual',
        headers: { Accept: 'application/json' },
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error('Identity key service unavailable.');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing identity keys.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) {
            await reader.cancel();
            throw new Error('Identity key response too large.');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return new Response(bytes, { headers: { 'Content-Type': 'application/json' } });
    },
  });
  return async (request, now) => {
    try {
      const url = new URL(request.url);
      if (url.protocol !== 'https:' || url.hostname !== settings.hostname || url.port) return false;
      const token = request.headers.get('cf-access-jwt-assertion');
      if (!token || token.length > 16384 || token.split('.').length !== 3) return false;
      const { payload, protectedHeader } = await jwtVerify(token, jwks, {
        issuer,
        audience: settings.audience,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'sub', 'email'],
        currentDate: now,
        clockTolerance: 5,
      });
      if (
        protectedHeader.crit !== undefined ||
        payload.type !== 'app' ||
        typeof payload.email !== 'string' ||
        !settings.emails.includes(payload.email.toLowerCase()) ||
        typeof payload.iat !== 'number' ||
        payload.iat > now.getTime() / 1000 + 5
      )
        return false;
      return true;
    } catch {
      // No JWT, key payload, upstream error or identity claims enter logs/responses.
      return false;
    }
  };
}
let cached: { key: string; authorize: AccessAuthorizer } | undefined;
export function workerAccess(env: AccessEnvironment): AccessAuthorizer | undefined {
  const settings = accessSettings(env);
  if (!settings) return undefined;
  const key = JSON.stringify(settings);
  if (cached?.key !== key) cached = { key, authorize: createAccessAuthorizer(settings) };
  return cached.authorize;
}
