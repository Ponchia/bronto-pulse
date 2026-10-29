#!/usr/bin/env python3
"""Opt-in private D1 export, restore verification, compression and retention."""
from __future__ import annotations
import argparse
import datetime as dt
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import uuid

MAXIMUM_BYTES = 64 * 1024 * 1024
TABLES = ("resources", "runs", "observations", "partitions", "annotations")
ARCHIVE = re.compile(r"^pulse-d1-\d{8}T\d{6}Z-[a-f0-9]{12}\.sql\.gz$")
# Wrangler diagnostics can name accounts and databases, so a failure reports only one of
# these fixed categories. The first matching pattern wins; anything else is "export-failed".
EXPORT_FAILURES = (
    ("authentication", re.compile(rb"not logged in|wrangler login|authenticat|invalid_grant|refresh token|oauth|\[code: 10000\]|unauthori[sz]ed|\b403\b", re.IGNORECASE)),
    ("rate-limited", re.compile(rb"rate limit|too many requests|\b429\b", re.IGNORECASE)),
    ("network", re.compile(rb"ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|fetch failed|socket hang up|network", re.IGNORECASE)),
    ("cloudflare-unavailable", re.compile(rb"\b50[0-4]\b|internal server error|service unavailable|bad gateway", re.IGNORECASE)),
)


class BackupFailure(Exception):
    """A failure whose message is a fixed category, safe for journals and alerts."""


def classify_export_failure(stderr: bytes) -> str:
    for category, pattern in EXPORT_FAILURES:
        if pattern.search(stderr):
            return category
    return "export-failed"


def verify_dump(raw: bytes) -> dict[str, int]:
    if not raw or len(raw) > MAXIMUM_BYTES:
        raise ValueError("Export is empty or exceeds the operator byte budget.")
    db = sqlite3.connect(":memory:")
    def authorize(action: int, arg1: str | None, arg2: str | None, *_: object) -> int:
        if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_FUNCTION and (arg2 or "").lower() == "load_extension":
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK
    try:
        db.set_authorizer(authorize)
        db.executescript(raw.decode("utf-8"))
        if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise ValueError("Restored database failed integrity validation.")
        if db.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("Restored database has invalid references.")
        return {name: db.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0] for name in TABLES}
    finally:
        db.close()


def private_directory(directory: Path) -> Path:
    if directory.is_symlink():
        raise ValueError("Backup destination cannot be a symbolic link.")
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    if not directory.is_dir() or directory.stat().st_uid != os.getuid():
        raise ValueError("Backup destination must be an operator-owned directory.")
    directory.chmod(0o700)
    return directory.resolve()


def publish(raw: bytes, directory: Path, now: dt.datetime | None = None) -> dict[str, object]:
    counts = verify_dump(raw)
    directory = private_directory(directory)
    now = now or dt.datetime.now(dt.timezone.utc)
    stamp = now.astimezone(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    name = f"pulse-d1-{stamp}-{uuid.uuid4().hex[:12]}.sql.gz"
    compressed = gzip.compress(raw, compresslevel=6, mtime=0)
    if verify_dump(gzip.decompress(compressed)) != counts:
        raise ValueError("Compressed archive did not round-trip.")
    result: dict[str, object] = {
        "schemaVersion": 1, "createdAt": now.astimezone(dt.timezone.utc).isoformat(),
        "file": name, "sha256": hashlib.sha256(compressed).hexdigest(),
        "sqlSha256": hashlib.sha256(raw).hexdigest(),
        "compressedBytes": len(compressed), "sqlBytes": len(raw),
        "integrity": "ok", "foreignKeyViolations": 0,
        "counts": counts, "offBoxVerified": False,
    }
    with os.fdopen(os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as handle:
        handle.write(compressed); handle.flush(); os.fsync(handle.fileno())
    with os.fdopen(os.open(directory / (name + ".json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as handle:
        json.dump(result, handle, indent=2); handle.write("\n"); handle.flush(); os.fsync(handle.fileno())
    return result


def prune(directory: Path, retain: int) -> int:
    if retain < 2 or retain > 365:
        raise ValueError("Retained backup count must be between 2 and 365.")
    verified: list[Path] = []
    for path in directory.iterdir():
        if not ARCHIVE.fullmatch(path.name) or path.is_symlink() or not path.is_file():
            continue
        manifest = path.with_name(path.name + ".json")
        if manifest.is_symlink() or not manifest.is_file() or manifest.stat().st_size > 65536:
            continue
        try:
            info = json.loads(manifest.read_text())
            if info.get("file") != path.name or info.get("integrity") != "ok" or path.stat().st_size > MAXIMUM_BYTES:
                continue
            if hashlib.sha256(path.read_bytes()).hexdigest() != info.get("sha256"):
                continue
            verified.append(path)
        except (ValueError, OSError):
            continue
    removed = 0
    for path in sorted(verified, key=lambda p: p.name, reverse=True)[retain:]:
        path.unlink(); path.with_name(path.name + ".json").unlink(); removed += 1
    return removed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wrangler", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--database", required=True)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--retain", type=int, default=14)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.database) or not 2 <= args.retain <= 365:
            raise ValueError("Invalid database name or retention bound.")
        binary, config = args.wrangler.resolve(strict=True), args.config.resolve(strict=True)
        if not binary.is_file() or not config.is_file():
            raise ValueError("Configured executable or deployment file is unavailable.")
        out = private_directory(args.out)
        fd = os.open(out / ".pulse-backup.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as held:
            try:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise BackupFailure("already-running") from None
            with tempfile.TemporaryDirectory(prefix=".pulse-export-", dir=out) as scratch:
                export = Path(scratch) / "export.sql"
                try:
                    run = subprocess.run(
                        [str(binary), "d1", "export", args.database, "--remote", "--config", str(config), "--output", str(export)],
                        cwd=config.parent, env=dict(os.environ, WRANGLER_SEND_METRICS="false", CI="true"),
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                        timeout=180, check=False,
                    )
                except subprocess.TimeoutExpired:
                    raise BackupFailure("export-timeout") from None
                if run.returncode != 0:
                    raise BackupFailure(classify_export_failure(run.stderr))
                if not export.is_file() or export.stat().st_size > MAXIMUM_BYTES:
                    raise BackupFailure("export-size")
                try:
                    result = publish(export.read_bytes(), out)
                except (ValueError, sqlite3.Error):
                    raise BackupFailure("restore-verification") from None
                result["oldOwnedArchivesRemoved"] = prune(out, args.retain)
                print(json.dumps(result))
        return 0
    except BackupFailure as failure:
        category = str(failure)
    except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError):
        category = "operator-setup"
    print(json.dumps({"ok": False, "category": category, "error": "Backup failed before verified completion. Inspect the private operator setup; prior verified archives remain."}))
    return 1

if __name__ == "__main__":
    raise SystemExit(main())
