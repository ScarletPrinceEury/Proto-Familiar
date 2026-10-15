"""Care-critical facts about my human — one matcher for every writer and reader.

A care-critical fact is one I must have in front of me when my human needs care:
allergies, medications and doses, crisis triggers, support contacts, what helps
and what doesn't. These used to be pinned in my always-injected identity files
— which also put them in front of everyone in a group chat. Since 0.14.70 (ward
decision) they live as `ward`-register standing facts marked care_weight 'high':
audience-gated like every memory, and put in front of me directly on my human's
own turns, in triage and in noticing (memory.list_care_facts).

The matcher is broad on purpose: a false positive only costs a little space in
the care block; a miss means a fact I needed isn't in front of me.
"""

from __future__ import annotations

import re

# Memorization-taxonomy categories that are care-relevant by category alone.
CARE_CATEGORIES = {"health_info", "crisis", "support-map"}

_CARE_PATTERNS = [
    r"allerg",                                  # allergy / allergic
    r"\bmed(s|ication|ications)?\b", r"\bdos(e|age)\b",
    r"\d+\s*m?g\b", r"\d+\s*ml\b", r"\bmcg\b",  # doses, incl. "50mg" (no word break)
    r"prescription", r"\bpill\b", r"insulin", r"inhaler", r"epi[\- ]?pen",
    r"suicid", r"self[\- ]?harm", r"overdose", r"\bcrisis\b", r"\brelapse\b",
    r"hotline", r"\b988\b", r"emergency contact", r"support (contact|person|map)",
    r"\btrigger(s|ed|ing)?\b", r"seizure", r"diabet", r"asthma", r"anaphyla",
    r"what helps", r"what doesn'?t help", r"do not (say|mention|bring up)",
]
_CARE_RE = re.compile("|".join(_CARE_PATTERNS), re.IGNORECASE)


def contains_care_critical(text: str | None) -> bool:
    """True if text mentions anything I must have in front of me when my human needs care."""
    if not text:
        return False
    return bool(_CARE_RE.search(text))
