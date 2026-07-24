"""normalize_date_key — coerce entity-core filename stems to an ISO-leading
date_key so migrated rows are legible to the consolidation ladder (which does
date.fromisoformat(date_key[:10])). Granularity is never touched by this; it
only fixes the date so a row can't be stranded off the sweep.
"""

from phylactery.migrate_from_entity_core import normalize_date_key as n


def test_iso_stem_is_unchanged():
    assert n("2025-05-23") == "2025-05-23"


def test_significant_slug_is_preserved():
    assert n("2025-05-23_tea-ritual") == "2025-05-23_tea-ritual"


def test_tier_prefixed_us_date_is_recovered():
    # The reported mislabel: a 'weekly-mm-dd-yyyy' stem.
    assert n("weekly-05-23-2025") == "2025-05-23"


def test_plain_us_date_becomes_iso():
    assert n("05-23-2025") == "2025-05-23"
    assert n("5-3-2025") == "2025-05-03"


def test_compact_yyyymmdd_becomes_iso():
    assert n("20250523") == "2025-05-23"


def test_daily_prefix_stripped():
    assert n("daily_2025-01-02") == "2025-01-02"


def test_unrecoverable_stem_is_left_verbatim():
    # Nothing is dropped — the audit flags it instead of the migration guessing.
    assert n("not-a-date") == "not-a-date"


def test_invalid_calendar_date_is_not_forced():
    # Month 13 isn't a date — leave it rather than fabricate one.
    assert n("13-40-2025") == "13-40-2025"
