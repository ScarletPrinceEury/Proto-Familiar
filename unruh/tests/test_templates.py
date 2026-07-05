"""Unit tests for the templates layer.

Run with: cd unruh && uv run pytest tests/test_templates.py -q

Each test uses a fresh in-memory DB (via the `conn` fixture) so
tests are isolated and the on-disk data/unruh.db is never touched.
"""

from __future__ import annotations

import sqlite3

import pytest

from unruh import templates as tmpl
from unruh.db import run_migrations


@pytest.fixture
def conn():
    """Fresh in-memory DB with migrations applied. Uses deferred-
    transaction mode (no isolation_level=None) to match production
    db.get_conn() after the #A4 fix, so tests exercise the same
    commit/rollback semantics the real connection does."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    run_migrations(c)
    yield c
    c.close()


# ── Migrations ────────────────────────────────────────────────────────


class TestMigrations:
    def test_templates_table_created(self, conn):
        """After run_migrations, the templates table exists."""
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='templates'"
        ).fetchone()
        assert row is not None, "templates table should exist"
        assert row["name"] == "templates"

    def test_templates_table_has_required_columns(self, conn):
        """The templates table has the expected columns."""
        rows = conn.execute("PRAGMA table_info(templates)").fetchall()
        columns = {r["name"] for r in rows}
        assert columns == {
            "id", "tag", "label", "prerequisites_json", "created_at", "updated_at"
        }, f"unexpected columns: {columns}"


# ── upsert_template ──────────────────────────────────────────────────


class TestUpsertTemplate:
    def test_upsert_creates_new_template(self, conn):
        """Upserting a new tag creates a record with the given data."""
        result = tmpl.upsert_template(
            conn,
            tag="outside",
            label="leaving the house",
            prerequisites=["clean clothes", "shoes"],
        )
        assert result["tag"] == "outside"
        assert result["label"] == "leaving the house"
        assert result["prerequisites"] == ["clean clothes", "shoes"]
        assert result["id"] is not None
        assert result["created_at"] is not None
        assert result["updated_at"] is not None

    def test_upsert_tag_lowercased(self, conn):
        """Tag is lowercased during storage."""
        result = tmpl.upsert_template(
            conn,
            tag="Outside",
            label="leaving the house",
        )
        assert result["tag"] == "outside"
        # Verify in DB
        row = conn.execute("SELECT tag FROM templates WHERE id = ?", (result["id"],)).fetchone()
        assert row["tag"] == "outside"

    def test_upsert_replaces_existing_tag(self, conn):
        """Upserting an existing tag replaces the label and prerequisites."""
        result1 = tmpl.upsert_template(
            conn,
            tag="outside",
            label="leaving the house v1",
            prerequisites=["shoes"],
        )
        id1 = result1["id"]

        result2 = tmpl.upsert_template(
            conn,
            tag="outside",
            label="leaving the house v2",
            prerequisites=["clean clothes", "shoes", "keys"],
        )
        id2 = result2["id"]

        # ID must be stable
        assert id1 == id2
        # Label and prerequisites updated
        assert result2["label"] == "leaving the house v2"
        assert result2["prerequisites"] == ["clean clothes", "shoes", "keys"]
        # Only one template in DB
        assert len(tmpl.list_templates(conn)) == 1

    def test_upsert_prerequisites_deduped_case_insensitive(self, conn):
        """Prerequisites are de-duplicated case-insensitively and trimmed."""
        result = tmpl.upsert_template(
            conn,
            tag="outside",
            label="test",
            prerequisites=["clean clothes", " Clean Clothes ", "shoes"],
        )
        assert result["prerequisites"] == ["clean clothes", "shoes"]

    def test_upsert_prerequisites_default_empty(self, conn):
        """Omitting prerequisites defaults to an empty list."""
        result = tmpl.upsert_template(
            conn,
            tag="outside",
            label="test",
        )
        assert result["prerequisites"] == []

    def test_upsert_empty_tag_raises(self, conn):
        """Empty tag raises ValueError."""
        with pytest.raises(ValueError, match="tag is required"):
            tmpl.upsert_template(conn, tag="", label="test")

        with pytest.raises(ValueError, match="tag is required"):
            tmpl.upsert_template(conn, tag="  ", label="test")

    def test_upsert_empty_label_raises(self, conn):
        """Empty label raises ValueError."""
        with pytest.raises(ValueError, match="label is required"):
            tmpl.upsert_template(conn, tag="outside", label="")

        with pytest.raises(ValueError, match="label is required"):
            tmpl.upsert_template(conn, tag="outside", label="  ")

    def test_upsert_none_tag_raises(self, conn):
        """None tag raises ValueError."""
        with pytest.raises(ValueError, match="tag is required"):
            tmpl.upsert_template(conn, tag=None, label="test")

    def test_upsert_none_label_raises(self, conn):
        """None label raises ValueError."""
        with pytest.raises(ValueError, match="label is required"):
            tmpl.upsert_template(conn, tag="outside", label=None)


# ── list_templates ───────────────────────────────────────────────────


class TestListTemplates:
    def test_list_empty_db(self, conn):
        """Empty DB returns empty list."""
        result = tmpl.list_templates(conn)
        assert result == []

    def test_list_single_template(self, conn):
        """Single template is returned."""
        tmpl.upsert_template(conn, tag="outside", label="test")
        result = tmpl.list_templates(conn)
        assert len(result) == 1
        assert result[0]["tag"] == "outside"

    def test_list_multiple_templates(self, conn):
        """Multiple templates are returned."""
        tmpl.upsert_template(conn, tag="outside", label="test1")
        tmpl.upsert_template(conn, tag="grocery", label="test2")
        tmpl.upsert_template(conn, tag="shower", label="test3")
        result = tmpl.list_templates(conn)
        assert len(result) == 3

    def test_list_ordered_by_tag_asc(self, conn):
        """Templates are ordered by tag (ascending)."""
        tmpl.upsert_template(conn, tag="zzz", label="test1")
        tmpl.upsert_template(conn, tag="aaa", label="test2")
        tmpl.upsert_template(conn, tag="mmm", label="test3")
        result = tmpl.list_templates(conn)
        tags = [t["tag"] for t in result]
        assert tags == ["aaa", "mmm", "zzz"]


# ── delete_template ──────────────────────────────────────────────────


class TestDeleteTemplate:
    def test_delete_existing_returns_true(self, conn):
        """Deleting an existing template returns True."""
        tmpl.upsert_template(conn, tag="outside", label="test")
        result = tmpl.delete_template(conn, tag="outside")
        assert result is True

    def test_delete_nonexistent_returns_false(self, conn):
        """Deleting a non-existent template returns False."""
        result = tmpl.delete_template(conn, tag="outside")
        assert result is False

    def test_delete_removes_from_db(self, conn):
        """After deletion, the template is not in DB."""
        tmpl.upsert_template(conn, tag="outside", label="test")
        tmpl.delete_template(conn, tag="outside")
        result = tmpl.list_templates(conn)
        assert result == []

    def test_delete_case_insensitive(self, conn):
        """Delete is case-insensitive (tag lowercased)."""
        tmpl.upsert_template(conn, tag="outside", label="test")
        result = tmpl.delete_template(conn, tag="OUTSIDE")
        assert result is True
        assert tmpl.list_templates(conn) == []

    def test_delete_empty_tag_raises(self, conn):
        """Empty tag raises ValueError."""
        with pytest.raises(ValueError, match="tag is required"):
            tmpl.delete_template(conn, tag="")

    def test_delete_none_tag_raises(self, conn):
        """None tag raises ValueError."""
        with pytest.raises(ValueError, match="tag is required"):
            tmpl.delete_template(conn, tag=None)


# ── Integration tests ────────────────────────────────────────────────


class TestIntegration:
    def test_full_lifecycle(self, conn):
        """Create, list, update, list, delete, list."""
        # Create
        result1 = tmpl.upsert_template(
            conn,
            tag="outside",
            label="leaving the house",
            prerequisites=["shoes"],
        )
        assert len(tmpl.list_templates(conn)) == 1

        # Update
        result2 = tmpl.upsert_template(
            conn,
            tag="outside",
            label="going out",
            prerequisites=["shoes", "keys"],
        )
        assert result2["id"] == result1["id"]
        assert result2["label"] == "going out"
        assert len(tmpl.list_templates(conn)) == 1

        # Delete
        deleted = tmpl.delete_template(conn, tag="outside")
        assert deleted is True
        assert len(tmpl.list_templates(conn)) == 0

    def test_multiple_independent_templates(self, conn):
        """Multiple templates can coexist independently."""
        outside = tmpl.upsert_template(
            conn,
            tag="outside",
            label="going out",
            prerequisites=["shoes", "keys"],
        )
        shower = tmpl.upsert_template(
            conn,
            tag="shower",
            label="taking a shower",
            prerequisites=["towel", "soap"],
        )
        grocery = tmpl.upsert_template(
            conn,
            tag="grocery",
            label="grocery shopping",
            prerequisites=["bag", "list"],
        )

        # All exist
        templates = tmpl.list_templates(conn)
        assert len(templates) == 3

        # Delete one
        tmpl.delete_template(conn, tag="shower")
        templates = tmpl.list_templates(conn)
        assert len(templates) == 2
        assert not any(t["tag"] == "shower" for t in templates)
        assert any(t["tag"] == "outside" for t in templates)
        assert any(t["tag"] == "grocery" for t in templates)
