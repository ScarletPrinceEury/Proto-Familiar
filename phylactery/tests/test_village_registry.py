"""village_registry stores the Village routing/gating JSON in the meta KV table,
NOT in identity_files — so it never appears in identity_get_all / the identity
block / the Knowledge editor's Identity tab. The first get/set also self-heals a
legacy custom/village-registry.md identity row: its JSON moves into meta and the
identity row is DELETED."""

import sqlite3
from phylactery import village_registry as vr


def _conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    c.execute(
        "CREATE TABLE identity_files(id TEXT PRIMARY KEY, category TEXT, filename TEXT, content TEXT)"
    )
    return c


def _seed_legacy(c, json_body='{"villagers":[],"categories":[]}'):
    content = f"## Registry\n\n```json\n{json_body}\n```"
    c.execute(
        "INSERT INTO identity_files VALUES('leg-1', 'custom', 'village-registry.md', ?)",
        (content,),
    )
    c.commit()


def test_set_then_get_roundtrips_via_meta():
    c = _conn()
    assert vr.get(c) is None
    r = vr.set_registry(c, '{"a":1}')
    assert r == {"ok": True}
    assert vr.get(c) == '{"a":1}'
    # It lives in meta, never identity.
    assert c.execute("SELECT value FROM meta WHERE key='village_registry'").fetchone()["value"] == '{"a":1}'


def test_get_heals_legacy_identity_row_into_meta_and_deletes_it():
    c = _conn()
    _seed_legacy(c, '{"villagers":["x"]}')
    # Before: the machine JSON is sitting in identity_files (the Identity-tab wart).
    assert c.execute("SELECT COUNT(*) AS n FROM identity_files").fetchone()["n"] == 1
    out = vr.get(c)
    # The fenced JSON was extracted into meta …
    assert out == '{"villagers":["x"]}'
    # … and the identity row is GONE (no longer in the Identity tab / prompt).
    assert c.execute("SELECT COUNT(*) AS n FROM identity_files").fetchone()["n"] == 0


def test_heal_never_overwrites_a_live_meta_value():
    c = _conn()
    vr.set_registry(c, '{"live":true}')        # a current value exists in meta
    _seed_legacy(c, '{"stale":true}')          # a stale identity copy appears
    assert vr.get(c) == '{"live":true}'         # live wins, stale is not restored
    assert c.execute("SELECT COUNT(*) AS n FROM identity_files").fetchone()["n"] == 0  # stale still retired


def test_set_retires_any_lingering_legacy_row():
    c = _conn()
    _seed_legacy(c)
    vr.set_registry(c, '{"b":2}')
    assert c.execute("SELECT COUNT(*) AS n FROM identity_files").fetchone()["n"] == 0
    assert vr.get(c) == '{"b":2}'


def test_set_rejects_empty_or_non_string():
    c = _conn()
    assert vr.set_registry(c, "")["ok"] is False
    assert vr.set_registry(c, "   ")["ok"] is False
    assert vr.set_registry(c, None)["ok"] is False  # type: ignore[arg-type]


def test_migration_is_idempotent():
    c = _conn()
    _seed_legacy(c, '{"once":1}')
    assert vr.get(c) == '{"once":1}'
    # A second call has nothing left to migrate and returns the meta value.
    assert vr.get(c) == '{"once":1}'
    assert c.execute("SELECT COUNT(*) AS n FROM identity_files").fetchone()["n"] == 0
