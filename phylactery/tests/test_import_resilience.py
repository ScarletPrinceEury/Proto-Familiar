"""A broken optional dependency must not take my whole self down.

This is the graceful-degradation rule as a test, and it exists because the
failure already happened: a partial `cryptography` install (two pure-Python
files missing, the native parts fine) made `backup.py` fail to import, which
made `server.py` fail to import, which meant Phylactery would not start at
all. Identity, memory and graph were unreachable because a BACKUP dependency
was broken.

Backups are a feature of the self-store, not a precondition for it.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parent.parent / "src" / "phylactery"

# Anything not in the standard library and not ours. A top-level import of one
# of these is a single point of failure for the entire server, because
# server.py imports these modules at load time.
EXTERNAL = {"cryptography", "httpx", "fastembed", "sqlite_vec", "numpy", "onnxruntime"}

# mcp is the server itself — without it there is nothing to degrade INTO, so
# it is allowed to be a hard requirement.
ALLOWED_HARD_DEPS = {"mcp"}


def _unguarded_external_imports(path: Path) -> list[str]:
    """Top-level imports of external packages that are not inside a try block."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found = []
    for node in tree.body:                      # module level only
        if isinstance(node, ast.Import):
            names = [a.name.split(".")[0] for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            names = [(node.module or "").split(".")[0]]
        else:
            continue
        for n in names:
            if n in EXTERNAL and n not in ALLOWED_HARD_DEPS:
                found.append(f"{path.name}:{node.lineno} imports {n}")
    return found


@pytest.mark.parametrize("path", sorted(SRC.glob("*.py")), ids=lambda p: p.name)
def test_no_unguarded_external_import_at_module_level(path: Path) -> None:
    problems = _unguarded_external_imports(path)
    assert not problems, (
        "an external package is imported at module level and unguarded:\n  "
        + "\n  ".join(problems)
        + "\n\nserver.py imports these modules at load, so a broken install of "
        "that package stops Phylactery starting at all. Guard it with try/except "
        "and report the failure from the functions that need it, or import it "
        "lazily inside the function."
    )


def test_backup_imports_even_without_cryptography(monkeypatch: pytest.MonkeyPatch) -> None:
    """The exact reported failure: cryptography broken, everything else fine."""
    for mod in [m for m in list(sys.modules) if m.startswith(("cryptography", "phylactery.backup"))]:
        monkeypatch.delitem(sys.modules, mod, raising=False)

    import builtins

    real_import = builtins.__import__

    def blocked(name, *args, **kwargs):
        if name.startswith("cryptography"):
            raise ModuleNotFoundError("No module named 'cryptography.fernet'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", blocked)

    import importlib

    backup = importlib.import_module("phylactery.backup")
    assert backup is not None, "the module must import even with crypto missing"

    status = backup.crypto_status()
    assert status["available"] is False
    assert "cryptography" in status["error"], "the error should name what to reinstall"


def test_backup_refuses_rather_than_writing_an_unencrypted_file(monkeypatch: pytest.MonkeyPatch) -> None:
    """A file the ward believes is encrypted, but is not, is worse than no file."""
    import importlib

    backup = importlib.import_module("phylactery.backup")
    monkeypatch.setattr(backup, "_CRYPTO_ERROR", "the encryption library is not usable")

    out = backup.export_encrypted("a-real-passphrase")
    assert out["ok"] is False
    assert "encryption" in out["error"]

    out = backup.restore_encrypted("anywhere.phylactery", "a-real-passphrase")
    assert out["ok"] is False
