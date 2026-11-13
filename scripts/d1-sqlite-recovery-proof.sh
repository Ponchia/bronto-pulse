#!/usr/bin/env bash
# Opt-in offline recovery proof from a trusted D1 SQL.gz export.
# No Cloudflare API calls, production changes or persistent report disclosure.
set -euo pipefail
umask 077

if (( $# != 1 )) || [[ ! -f "$1" ]]; then
  echo 'Usage: bash scripts/d1-sqlite-recovery-proof.sh /private/trusted-d1-export.sql.gz' >&2
  exit 2
fi
for cmd in sqlite3 gzip node; do
  command -v "$cmd" >/dev/null || { echo "Missing recovery dependency: $cmd" >&2; exit 2; }
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cli="$root/dist/cli.js"
[[ -f "$cli" ]] || { echo 'Build Pulse with npm run build before testing recovery.' >&2; exit 2; }
archive="$1"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/pulse-d1-recovery.XXXXXXXX")"
cleanup() {
  if [[ "$tmp" == "${TMPDIR:-/tmp}/pulse-d1-recovery."* ]]; then rm -rf -- "$tmp"; fi
}
trap cleanup EXIT

# Optional operator backup manifest may prove archive bytes; lack of manifest
# does not make a foreign SQL file trusted, so operators must review its source.
node - "$archive" <<'JS'
const fs = require('node:fs');
const crypto = require('node:crypto');
const filename = process.argv[2];
if (fs.existsSync(filename + '.json')) {
  const meta = JSON.parse(fs.readFileSync(filename + '.json', 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(meta.sha256 || '')) throw Error('Unrecognized backup manifest');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  if (actual !== meta.sha256) throw Error('D1 archive checksum mismatch');
  process.stdout.write('D1_ARCHIVE_CHECKSUM_MATCH\n');
} else process.stdout.write('D1_ARCHIVE_MANIFEST_ABSENT: trusted source is operator responsibility\n');
JS
gzip -t -- "$archive"
gzip -cd -- "$archive" > "$tmp/backup.sql"
if grep -Eiq '^[[:space:]]*(BEGIN|COMMIT|END TRANSACTION)([[:space:];]|$)' "$tmp/backup.sql"; then
  echo 'Unexpected transaction in SQL export; verify backup format instead of nesting transactions.' >&2
  exit 2
fi

# Wrangler D1 exports contain many individual INSERT statements. A single
# transaction makes recovery practical even on a slow persistent disk.
{
  printf 'BEGIN IMMEDIATE;\n'
  cat "$tmp/backup.sql"
  printf '\nCOMMIT;\n'
} | sqlite3 -batch -cmd '.bail on' "$tmp/recovered.db" > "$tmp/sqlite-restore.log"

check_db() {
  local integrity fk
  integrity="$(sqlite3 -batch "$1" 'PRAGMA integrity_check;')"
  fk="$(sqlite3 -batch "$1" 'SELECT count(*) FROM pragma_foreign_key_check;')"
  [[ "$integrity" == ok && "$fk" == 0 ]] || { echo 'SQLite integrity/foreign-key check failed.' >&2; exit 1; }
}
check_db "$tmp/recovered.db"
sqlite3 -batch "$tmp/recovered.db" "SELECT value FROM metadata WHERE key='config';" > "$tmp/pulse.config.json"
[[ -s "$tmp/pulse.config.json" ]] || { echo 'Recovered D1 catalog lacks registered Pulse config.' >&2; exit 1; }

node - "$tmp/pulse.config.json" "$tmp/recovered.db" "$tmp/report-period.json" <<'JS'
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const [configPath, dbPath, outputPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const project = config.projects?.[0]?.id;
if (!/^[a-z][a-z0-9_-]{0,63}$/.test(project || '')) throw Error('No valid project for a sample report');
const to = execFileSync('sqlite3', ['-batch', dbPath, 'SELECT MAX(day) FROM partitions;'], {encoding:'utf8'}).trim();
if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) throw Error('No published date to compare');
const fromDate = new Date(to + 'T00:00:00Z');
fromDate.setUTCDate(fromDate.getUTCDate()-27);
fs.writeFileSync(outputPath, JSON.stringify({project, from: fromDate.toISOString().slice(0, 10), to}));
JS
# Bash 3.2 on macOS has no readarray; source fields are explicitly bounded,
# so a tab-separated tuple can be parsed without executing JSON-derived text.
IFS=$'\t' read -r project from to <<< "$(node - "$tmp/report-period.json" <<'JS'
const p = require(process.argv[2]);
process.stdout.write([p.project, p.from, p.to].join('\t') + '\n');
JS
)"
[[ -n "$project" && -n "$from" && -n "$to" ]] || { echo 'Missing recovery report scope.' >&2; exit 1; }
node "$cli" report "$project" --config "$tmp/pulse.config.json" --db "$tmp/recovered.db" --from "$from" --to "$to" --format json --out "$tmp/before.json" > "$tmp/report-before.log"
node "$cli" export --config "$tmp/pulse.config.json" --db "$tmp/recovered.db" --out "$tmp/portable.json" > "$tmp/export.log"
node "$cli" import --config "$tmp/pulse.config.json" --db "$tmp/imported.db" --input "$tmp/portable.json" > "$tmp/import.log"
check_db "$tmp/imported.db"
node "$cli" report "$project" --config "$tmp/pulse.config.json" --db "$tmp/imported.db" --from "$from" --to "$to" --format json --out "$tmp/after.json" > "$tmp/report-after.log"

node - "$tmp" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
const before = JSON.parse(fs.readFileSync(path.join(dir,'before.json'),'utf8'));
const after = JSON.parse(fs.readFileSync(path.join(dir,'after.json'),'utf8'));
for (const key of ['project','window','cards','breakdowns','evidence','warnings','annotations','inspections'])
  if (JSON.stringify(before[key])!==JSON.stringify(after[key])) throw Error('Portable report mismatch: '+key);
console.log('D1_TO_SQLITE_RECOVERY_VERIFIED: archive integrity, published-history import and source-aware report parity');
console.log('Raw superseded runs/observations are not required to match the portable snapshot.');
JS
