import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
const require = createRequire(import.meta.url);
const { Miniflare } = require('miniflare');
const { build } = require('esbuild');
const at = Date.now();
const settings = {
  team: 'example.cloudflareaccess.com',
  audience: 'a'.repeat(64),
  hostname: 'pulse.example.invalid',
  emails: ['owner@example.invalid'],
};
const keys = await generateKeyPair('RS256', { extractable: true });
const jwk = {
  ...(await exportJWK(keys.publicKey)),
  kid: 'synthetic-runtime-key',
  alg: 'RS256',
  use: 'sig',
};
const token = await new SignJWT({ email: 'owner@example.invalid', type: 'app' })
  .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
  .setIssuer(`https://${settings.team}`)
  .setAudience(settings.audience)
  .setSubject('synthetic-subject')
  .setIssuedAt(Math.floor(at / 1000))
  .setExpirationTime(Math.floor(at / 1000) + 3600)
  .sign(keys.privateKey);
const bundle = await build({
  entryPoints: [new URL('../src/api/access.ts', import.meta.url).pathname],
  bundle: true,
  minify: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
});
const script = `import {createAccessAuthorizer} from './access.js';
const settings=${JSON.stringify(settings)};
let calls=0;
const authorize=createAccessAuthorizer(settings,async (url,init)=>{
 const req=new Request(url,init);calls++;
 if(req.url!=='https://example.cloudflareaccess.com/cdn-cgi/access/certs'||req.redirect!=='manual')throw Error('Invalid key request');
 return Response.json({keys:[${JSON.stringify(jwk)}]});
});
export default {async fetch(){
 const valid=new Request('https://pulse.example.invalid/api/v1/projects',{headers:{'cf-access-jwt-assertion':${JSON.stringify(token)}}});
 const first=await authorize(valid,new Date(${at}));
 const second=await authorize(valid,new Date(${at}));
 const spoofed=await authorize(new Request('https://pulse.example.invalid/',{headers:{'cf-access-authenticated-user-email':'owner@example.invalid'}}),new Date(${at}));
 const expired=await authorize(valid,new Date(${at}+7200000));
 return Response.json({first,second,spoofed,expired,calls});
}};`;
const mf = new Miniflare({
  workers: [
    {
      config: {
        name: 'pulse-access-contract',
        compatibilityDate: '2026-10-01',
        manifest: {
          mainModule: 'index.js',
          modulesRoot: '/',
          modules: {
            'index.js': { type: 'esm', contents: script },
            'access.js': { type: 'esm', contents: bundle.outputFiles[0].text },
          },
        },
        env: {},
      },
    },
  ],
});
try {
  assert.deepEqual(await (await mf.dispatchFetch('http://localhost/')).json(), {
    first: true,
    second: true,
    spoofed: false,
    expired: false,
    calls: 1,
  });
  console.log(
    'ACCESS WORKER CONTRACT PASSED: native WebCrypto signature verification, pinned issuer/audience, JWKS caching, expiry and spoofed-header rejection.',
  );
} finally {
  await mf.dispose();
}
