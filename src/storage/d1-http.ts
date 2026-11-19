import { PulseError } from '../errors.js';
import type { SqlDriver, Statement } from './driver.js';

export interface D1OperatorOptions {
  accountId: string;
  databaseId: string;
  apiToken: string;
  fetcher?: typeof fetch;
}
type Row = Record<string, unknown>;
/**
 * Explicit operator adapter to the fixed Cloudflare administrative API.
 * Never exposed as an HTTP/agent SQL endpoint. Each batch uses one bounded request.
 * Ambiguous writes are not retried; callers recover by their stable record id.
 */
export class D1HttpDriver implements SqlDriver {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly token: string;
  constructor(options: D1OperatorOptions) {
    if (
      !/^[a-f0-9]{32}$/i.test(options.accountId) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.databaseId) ||
      !options.apiToken ||
      /[\r\n]/.test(options.apiToken)
    )
      throw new PulseError(
        'CONFIG',
        'Remote D1 requires valid account/database identifiers and an operator token.',
      );
    this.endpoint =
      'https://api.cloudflare.com/client/v4/accounts/' +
      options.accountId +
      '/d1/database/' +
      options.databaseId +
      '/query';
    this.fetcher = options.fetcher ?? fetch;
    this.token = options.apiToken;
  }
  async all<T extends Row>(statement: Statement): Promise<T[]> {
    return (await this.execute([statement]))[0] as T[];
  }
  async batch(statements: Statement[]): Promise<void> {
    if (statements.length) await this.execute(statements);
  }
  async readBatch(statements: Statement[]): Promise<Row[][]> {
    return statements.length ? this.execute(statements) : [];
  }
  private async execute(statements: Statement[]): Promise<Row[][]> {
    if (statements.length > 100)
      throw new PulseError('ROW_LIMIT', 'D1 operator batch exceeds 100 statements.');
    const body = JSON.stringify({
      batch: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })),
    });
    if (new TextEncoder().encode(body).byteLength > 1024 * 1024)
      throw new PulseError('ROW_LIMIT', 'D1 operator request exceeds its byte budget.');
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new PulseError(
        'UNAVAILABLE',
        'D1 operator request outcome is unknown. Check the stored record before retrying a write.',
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PulseError(
        response.status === 401 || response.status === 403 ? 'AUTH' : 'UNAVAILABLE',
        'D1 operator request was rejected. Check database access and provider status.',
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new PulseError('UNAVAILABLE', 'D1 operator response is missing.');
    const decoder = new TextDecoder();
    let text = '',
      bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 16 * 1024 * 1024) {
          await reader.cancel();
          throw new PulseError('ROW_LIMIT', 'D1 operator response exceeds its byte budget.');
        }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      if (error instanceof PulseError) throw error;
      throw new PulseError(
        'UNAVAILABLE',
        'D1 response was interrupted. Verify the stored result before retrying.',
      );
    }
    let value: { success?: boolean; result?: { success?: boolean; results?: Row[] }[] };
    try {
      value = JSON.parse(text);
    } catch {
      throw new PulseError('UNAVAILABLE', 'D1 operator response is invalid.');
    }
    if (
      value?.success !== true ||
      !Array.isArray(value.result) ||
      value.result.length !== statements.length ||
      value.result.some(
        (r) =>
          r?.success !== true ||
          !Array.isArray(r.results) ||
          r.results.some((row) => row === null || typeof row !== 'object' || Array.isArray(row)),
      )
    )
      throw new PulseError(
        'UNAVAILABLE',
        'D1 operator batch did not return a complete successful result.',
      );
    return value.result.map((r) => r.results!);
  }
}
export function d1OperatorDriver(env: Readonly<Record<string, string | undefined>>): D1HttpDriver {
  return new D1HttpDriver({
    accountId: env.CLOUDFLARE_ACCOUNT_ID ?? '',
    databaseId: env.PULSE_D1_DATABASE_ID ?? '',
    apiToken: env.CLOUDFLARE_API_TOKEN ?? '',
  });
}
