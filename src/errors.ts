export type ErrorCode =
  | 'CONFIG'
  | 'AUTH'
  | 'PERMISSION'
  | 'RATE_LIMIT'
  | 'NETWORK'
  | 'REDIRECT'
  | 'SCHEMA'
  | 'ROW_LIMIT'
  | 'UNAVAILABLE'
  | 'LEASE_LOST'
  | 'CONFLICT'
  | 'NOT_FOUND';
/** Messages are controlled by us. Never persist untrusted upstream bodies or secrets. */
export class PulseError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'PulseError';
  }
}
export function safeError(error: unknown): { code: ErrorCode; message: string } {
  return error instanceof PulseError
    ? { code: error.code, message: error.message.slice(0, 400) }
    : {
        code: 'UNAVAILABLE',
        message:
          'Operation failed. Check the private operator environment; no upstream payload was stored.',
      };
}
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PulseError('SCHEMA', message);
}
