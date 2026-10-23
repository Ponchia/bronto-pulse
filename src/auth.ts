import type { Connection } from './config.js';
import { PulseError } from './errors.js';
import { HttpClient } from './http.js';
import { object, text } from './validation.js';
export type Secrets = Record<string, string | undefined>;
function required(env: Secrets, name: string | undefined): string {
  const value = name ? env[name] : undefined;
  if (!value?.trim())
    throw new PulseError(
      'AUTH',
      `Required environment credential ${name ?? '(unconfigured)'} is unavailable.`,
    );
  return value.trim();
}
export function credentialStatus(
  c: Connection | undefined,
  env: Secrets,
): { available: boolean; method: string; missing: string[] } {
  if (!c) return { available: false, method: 'unconfigured', missing: ['connection'] };
  const method =
    c.tokenEnv && env[c.tokenEnv]
      ? 'token'
      : c.provider === 'gsc'
        ? c.serviceAccountJsonEnv
          ? 'service-account'
          : 'oauth-refresh'
        : c.provider === 'github' && c.appIdEnv
          ? 'github-app'
          : 'token';
  const names =
    method === 'token'
      ? [c.tokenEnv]
      : method === 'service-account'
        ? [c.serviceAccountJsonEnv]
        : method === 'oauth-refresh'
          ? [c.clientIdEnv, c.clientSecretEnv, c.refreshTokenEnv]
          : [c.appIdEnv, c.privateKeyEnv, c.installationIdEnv];
  const missing = names.filter((n) => !n || !env[n]).map((n) => n ?? '(not configured)');
  return { available: missing.length === 0, method, missing };
}
const encoder = new TextEncoder();
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function b64url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export async function githubAppJwt(appId: string, pem: string, now: Date): Promise<string> {
  if (!/^\d+$/.test(appId)) throw new PulseError('CONFIG', 'GitHub App ID must be numeric.');
  // PKCS8 only: no shell openssl invocation or unsafe key conversion at runtime.
  if (!pem.includes('-----BEGIN PRIVATE KEY-----'))
    throw new PulseError(
      'CONFIG',
      'GitHub App key must be unencrypted PKCS8 PEM. Convert locally with openssl pkcs8.',
    );
  let key: CryptoKey;
  try {
    const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    key = await crypto.subtle.importKey(
      'pkcs8',
      bytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    throw new PulseError('AUTH', 'GitHub App private key could not be parsed.');
  }
  const time = Math.floor(now.getTime() / 1000);
  const message =
    b64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))) +
    '.' +
    b64url(encoder.encode(JSON.stringify({ iat: time - 30, exp: time + 540, iss: appId })));
  const signed = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(message));
  return message + '.' + b64url(new Uint8Array(signed));
}
/** Only the signing identity/key are read; supplied token_uri, scopes and delegation are ignored. */
export async function googleServiceAccountJwt(raw: string, now: Date): Promise<string> {
  try {
    if (raw.length > 32768) throw new Error();
    const data = JSON.parse(raw);
    if (
      !data ||
      data.type !== 'service_account' ||
      typeof data.client_email !== 'string' ||
      data.client_email !== data.client_email.trim() ||
      data.client_email.includes('..') ||
      !/^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9-]*\.iam\.gserviceaccount\.com$/i.test(
        data.client_email,
      ) ||
      data.client_email.length > 254 ||
      typeof data.private_key !== 'string' ||
      !/^-----BEGIN PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]+-----END PRIVATE KEY-----\s*$/.test(
        data.private_key,
      )
    )
      throw new Error();
    const bytes = Uint8Array.from(
      atob(data.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')),
      (c) => c.charCodeAt(0),
    );
    const key = await crypto.subtle.importKey(
      'pkcs8',
      bytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    if ((key.algorithm as RsaKeyAlgorithm).modulusLength < 2048) throw new Error();
    const time = Math.floor(now.getTime() / 1000);
    const message =
      b64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))) +
      '.' +
      b64url(
        encoder.encode(
          JSON.stringify({
            iss: data.client_email,
            scope: 'https://www.googleapis.com/auth/webmasters.readonly',
            aud: 'https://oauth2.googleapis.com/token',
            iat: time,
            exp: time + 3600,
          }),
        ),
      );
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(message));
    return message + '.' + b64url(new Uint8Array(signature));
  } catch {
    throw new PulseError(
      'AUTH',
      'Google service-account JSON, signing identity or PKCS8 RSA key is invalid.',
    );
  }
}
export class Credentials {
  private readonly cache = new Map<string, { value: string; expires: number }>();
  constructor(
    private readonly env: Secrets,
    private readonly http: HttpClient,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async token(c: Connection | undefined): Promise<string> {
    if (!c)
      throw new PulseError('AUTH', 'No credential connection is configured for this resource.');
    if (c.tokenEnv && this.env[c.tokenEnv]) return required(this.env, c.tokenEnv);
    const cached = this.cache.get(c.id);
    if (cached && cached.expires > this.now().getTime() + 60000) return cached.value;
    if (c.provider === 'gsc') {
      const body = new URLSearchParams(
        c.serviceAccountJsonEnv
          ? {
              grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
              assertion: await googleServiceAccountJwt(
                required(this.env, c.serviceAccountJsonEnv),
                this.now(),
              ),
            }
          : {
              grant_type: 'refresh_token',
              client_id: required(this.env, c.clientIdEnv),
              client_secret: required(this.env, c.clientSecretEnv),
              refresh_token: required(this.env, c.refreshTokenEnv),
            },
      );
      const data = object(
        await this.http.json('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        }),
      );
      const value = text(data.access_token, 'Google access token', 8192);
      const lifetime =
        data.expires_in === undefined
          ? 3600
          : typeof data.expires_in === 'number' &&
              Number.isFinite(data.expires_in) &&
              data.expires_in > 0
            ? Math.min(data.expires_in, 3600)
            : 0;
      if (!value || lifetime === 0)
        throw new PulseError('AUTH', 'Google returned an invalid token lifetime or access token.');
      this.cache.set(c.id, { value, expires: this.now().getTime() + lifetime * 1000 });
      return value;
    }
    if (c.provider === 'github' && c.appIdEnv) {
      const jwt = await githubAppJwt(
        required(this.env, c.appIdEnv),
        required(this.env, c.privateKeyEnv),
        this.now(),
      );
      const installation = required(this.env, c.installationIdEnv);
      if (!/^\d+$/.test(installation))
        throw new PulseError('CONFIG', 'GitHub installation ID must be numeric.');
      const data = object(
        await this.http.json(
          `https://api.github.com/app/installations/${installation}/access_tokens`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${jwt}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2026-03-10',
            },
            body: '{}',
          },
        ),
      );
      const value = text(data.token, 'GitHub installation token', 8192);
      this.cache.set(c.id, { value, expires: this.now().getTime() + 3300000 });
      return value;
    }
    return required(this.env, c.tokenEnv);
  }
}
