import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const modulePath = fileURLToPath(new URL('../scripts/operator-backup.py', import.meta.url));
test('operator backups verify restored bytes, reject unsafe dumps and retain only owned archives', () => {
  execFileSync(
    'python3',
    [
      '-c',
      String.raw`
import datetime as dt,gzip,importlib.util,json,os,sqlite3,stat,sys,tempfile
from pathlib import Path
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('pulse_backup',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
raw=("CREATE TABLE resources(id TEXT PRIMARY KEY);INSERT INTO resources VALUES ('synthetic');"+''.join('CREATE TABLE '+name+'(id TEXT);' for name in m.TABLES if name!='resources')).encode()
assert m.verify_dump(raw)['resources']==1
for bad in [b'',b'not SQL',raw+b"ATTACH DATABASE '/tmp/forbidden-pulse-backup-probe' AS other;",raw+b"CREATE TABLE child(id TEXT REFERENCES resources(id));INSERT INTO child VALUES ('missing');"]:
 try:m.verify_dump(bad)
 except (ValueError,sqlite3.Error):pass
 else:raise AssertionError('invalid export accepted')
with tempfile.TemporaryDirectory() as d:
 out=Path(d)/'private'
 results=[m.publish(raw,out,dt.datetime(2026,1,i,tzinfo=dt.timezone.utc)) for i in (1,2,3)]
 first=out/results[0]['file'];assert stat.S_IMODE(first.stat().st_mode)==0o600
 assert stat.S_IMODE(out.stat().st_mode)==0o700
 assert gzip.decompress(first.read_bytes())==raw
 assert json.loads((out/(results[0]['file']+'.json')).read_text())['offBoxVerified'] is False
 unrelated=out/'unrelated.sql.gz';unrelated.write_bytes(b'private-owned-elsewhere')
 before=set(out.iterdir())
 try:m.publish(b'invalid export',out)
 except (ValueError,sqlite3.Error):pass
 else:raise AssertionError('invalid archive published')
 assert before==set(out.iterdir())
 assert m.prune(out,2)==1 and unrelated.read_bytes()==b'private-owned-elsewhere'
 assert not first.exists() and (out/results[2]['file']).exists()
 link=Path(d)/'link';link.symlink_to(out)
 try:m.publish(raw,link)
 except ValueError:pass
 else:raise AssertionError('symlink destination accepted')
print('Private backup restore, corruption, attachment, permissions and retention contracts passed.')
`,
      modulePath,
    ],
    { stdio: 'pipe', timeout: 30000 },
  );
});
test('operator backup failures report a fixed category and never echo Wrangler diagnostics', () => {
  execFileSync(
    'python3',
    [
      '-c',
      String.raw`
import json,os,stat,subprocess,sys,tempfile
from pathlib import Path
script=sys.argv[1]
cases=[('echo "X [ERROR] Not logged in. Run wrangler login. account 0123abcd-secret-name" >&2; exit 1','authentication'),
       ('echo "X [ERROR] fetch failed: ECONNRESET account 0123abcd-secret-name" >&2; exit 1','network'),
       ('echo "X [ERROR] 429 Too Many Requests account 0123abcd-secret-name" >&2; exit 1','rate-limited'),
       ('echo "X [ERROR] unexpected account 0123abcd-secret-name" >&2; exit 7','export-failed'),
       ('exit 0','export-size')]
with tempfile.TemporaryDirectory() as d:
 d=Path(d);config=d/'wrangler.json';config.write_text('{}')
 for body,expected in cases:
  fake=d/'wrangler';fake.write_text('#!/bin/sh\n'+body+'\n');fake.chmod(0o700)
  run=subprocess.run([sys.executable,script,'--wrangler',str(fake),'--config',str(config),'--database','pulse','--out',str(d/'out')],capture_output=True,timeout=30)
  assert run.returncode==1,(expected,run.returncode)
  result=json.loads(run.stdout)
  assert result['ok'] is False and result['category']==expected,(expected,result)
  assert b'0123abcd' not in run.stdout+run.stderr,expected
 assert not [p for p in (d/'out').iterdir() if p.name.endswith('.gz')]
print('Backup failure categories passed without leaking Wrangler diagnostics.')
`,
      modulePath,
    ],
    { stdio: 'pipe', timeout: 60000 },
  );
});
