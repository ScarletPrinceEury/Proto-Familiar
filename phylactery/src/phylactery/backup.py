"""Single-file backup / restore (Pillar H), passphrase-encrypted at rest.

"Back up my Familiar" / "restore my Familiar" — the whole self (identity,
memory, graph, trackers, snapshots metadata) in one portable file the ward
controls. The file is encrypted with a key derived from the ward's passphrase,
so a backup sitting in cloud storage or on a USB stick discloses nothing
without it.

Format (.phylactery file):
  magic   4 bytes  b"PHB1"
  salt    16 bytes PBKDF2 salt
  token   rest     Fernet(AES128-CBC + HMAC) of a VACUUM INTO'd .sqlite

Restore decrypts to a temp file, sanity-checks it is a real SQLite DB with a
`memories` table, then swaps it over the live DB (WAL files dropped). The MCP
connection must be re-established afterwards — thalamus does this.

⚠️ The passphrase is never stored. A lost passphrase means an unrecoverable
backup — that is the point of encryption-at-rest. Callers must surface this.
"""

from __future__ import annotations

import base64
import os
import shutil
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

from phylactery.db import get_conn, now_iso, default_db_path


class _CryptoUnavailable(Exception):
    """Stands in for InvalidToken when cryptography could not be imported."""


# ⚠️ Backups must never be able to take my whole self down with them.
#
# This import used to be unguarded, and `server.py` imports this module at
# load. So when a `cryptography` install went partial — two pure-Python files
# missing, the native parts fine — the ModuleNotFoundError propagated all the
# way out and Phylactery refused to start at all. My human lost identity,
# memory and graph because a BACKUP dependency was broken.
#
# That is the graceful-degradation rule exactly: no module may take down the
# thing it is a feature of. Backups are a feature of the self-store, not a
# precondition for it. If crypto is missing, backup and restore say so
# clearly and everything else carries on.
try:
    from cryptography.fernet import Fernet, InvalidToken
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    _CRYPTO_ERROR: str | None = None
except Exception as _exc:  # noqa: BLE001 — any import failure degrades the same way
    Fernet = None  # type: ignore[assignment]
    hashes = None  # type: ignore[assignment]
    PBKDF2HMAC = None  # type: ignore[assignment]
    InvalidToken = _CryptoUnavailable  # type: ignore[misc,assignment]
    _CRYPTO_ERROR = (
        f"the encryption library is not usable ({type(_exc).__name__}: {_exc}). "
        "Backups and restores are unavailable until it is reinstalled — "
        "try: uv sync --reinstall-package cryptography --directory phylactery"
    )


def crypto_status() -> dict[str, Any]:
    """Whether backups can run. Observable rather than discovered mid-backup."""
    return {"available": _CRYPTO_ERROR is None, "error": _CRYPTO_ERROR}

_MAGIC = b"PHB1"
_SALT_LEN = 16
_KDF_ITERATIONS = 480_000  # OWASP-ish floor for PBKDF2-HMAC-SHA256


def _derive_key(passphrase: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=_KDF_ITERATIONS)
    return base64.urlsafe_b64encode(kdf.derive(passphrase.encode("utf-8")))


def _backups_dir() -> Path:
    return default_db_path().parent / "backups"


def export_encrypted(passphrase: str, conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    """VACUUM the live DB into a temp file, encrypt it, write the .phylactery blob."""
    if _CRYPTO_ERROR:
        # Refuse plainly rather than writing an UNENCRYPTED backup. A file the
        # ward believes is encrypted but is not would be worse than no backup.
        return {"ok": False, "error": _CRYPTO_ERROR}
    if not passphrase or len(passphrase) < 4:
        return {"ok": False, "error": "passphrase too short (need at least 4 characters)"}
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    tmp_path = None
    try:
        out_dir = _backups_dir()
        out_dir.mkdir(parents=True, exist_ok=True)
        ts = now_iso().replace(":", "-").replace("+", "Z")
        out_path = out_dir / f"familiar-backup-{ts}.phylactery"

        # VACUUM INTO a private temp file (consistent, compacted copy).
        fd, tmp_name = tempfile.mkstemp(suffix=".sqlite")
        os.close(fd)
        tmp_path = Path(tmp_name)
        tmp_path.unlink()  # VACUUM INTO requires the target not to exist
        conn.execute(f"VACUUM INTO '{tmp_path}'")

        plaintext = tmp_path.read_bytes()
        salt = os.urandom(_SALT_LEN)
        token = Fernet(_derive_key(passphrase, salt)).encrypt(plaintext)
        out_path.write_bytes(_MAGIC + salt + token)

        return {"ok": True, "filePath": str(out_path), "sizeBytes": out_path.stat().st_size}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        if tmp_path and tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
        if own_conn:
            conn.close()


def restore_encrypted(file_path: str, passphrase: str) -> dict[str, Any]:
    """Decrypt a .phylactery backup and swap it over the live DB."""
    if _CRYPTO_ERROR:
        return {"ok": False, "error": _CRYPTO_ERROR}
    src = Path(file_path)
    if not src.exists():
        return {"ok": False, "error": f"backup file not found: {file_path}"}
    tmp_path = None
    try:
        blob = src.read_bytes()
        if blob[:4] != _MAGIC:
            return {"ok": False, "error": "not a Phylactery backup file (bad magic)"}
        salt = blob[4:4 + _SALT_LEN]
        token = blob[4 + _SALT_LEN:]
        try:
            plaintext = Fernet(_derive_key(passphrase, salt)).decrypt(token)
        except InvalidToken:
            return {"ok": False, "error": "wrong passphrase or corrupted backup"}

        fd, tmp_name = tempfile.mkstemp(suffix=".sqlite")
        os.close(fd)
        tmp_path = Path(tmp_name)
        tmp_path.write_bytes(plaintext)

        # Sanity-check it's a real Phylactery DB before clobbering the live one.
        try:
            check = sqlite3.connect(str(tmp_path))
            has = check.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
            ).fetchone()
            check.close()
        except sqlite3.DatabaseError:
            has = None
        if not has:
            return {"ok": False, "error": "decrypted file is not a valid Phylactery database"}

        live_path = default_db_path()
        for suffix in ("", "-shm", "-wal"):
            victim = Path(str(live_path) + suffix)
            if victim.exists():
                victim.unlink()
        shutil.copy2(str(tmp_path), str(live_path))
        return {"ok": True, "restoredFrom": str(src)}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        if tmp_path and tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
