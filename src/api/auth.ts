const encoder = new TextEncoder();
function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
async function equal(a: string, b: string): Promise<boolean> {
  // Fixed-length digest comparison also avoids leaking token length/content through early string equality.
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  let diff = 0;
  const av = new Uint8Array(da),
    bv = new Uint8Array(db);
  for (let i = 0; i < av.length; i++) diff |= av[i]! ^ bv[i]!;
  return diff === 0;
}
async function signature(token: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
export async function makeSession(token: string, now = Date.now()): Promise<string> {
  const payload = `${Math.floor(now / 1000) + 3600}.${crypto.randomUUID()}`;
  return payload + '.' + (await signature(token, payload));
}
export async function authorized(
  request: Request,
  token: string,
  now = Date.now(),
): Promise<boolean> {
  if (token.length < 24) return false;
  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return equal(auth.slice(7), token);
  const value = request.headers
    .get('cookie')
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith('pulse_session='))
    ?.slice('pulse_session='.length);
  if (!value || value.length > 200) return false;
  const match = /^(\d+)\.([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(value);
  if (!match) return false;
  const expiry = Number(match[1]);
  if (expiry < now / 1000 || expiry > now / 1000 + 3605) return false;
  return equal(match[3]!, await signature(token, `${match[1]}.${match[2]}`));
}
export async function validToken(input: string, token: string): Promise<boolean> {
  return token.length >= 24 && (await equal(input, token));
}
