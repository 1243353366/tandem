"""Closed vocabularies and tag normalization for the Tandem matcher.

Two rules keep this honest:

1. The vocabulary is closed. A profile that says ``looking_for: ["pen pal"]``
   matches nothing, rather than silently scoring on a string nobody implemented.
2. Tags are canonicalized once, here, so that "ML", "machine-learning" and
   "ml " are the same interest everywhere downstream.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Iterable

ENGINE_VERSION = "1.1.0"
VOCAB_VERSION = "2026-11-01"

#: What people can say they are looking for.
LOOKING_FOR = (
    "cofounder",
    "collaborator",
    "study_partner",
    "accountability",
    "mentor",       # wants to be mentored
    "mentee",       # willing to mentor someone else
    "hobby_group",
    "friend",
)

#: What people can offer, independent of what they want.
OFFERS = (
    "cofounder",
    "collaborator",
    "study_partner",
    "accountability",
    "mentor",       # can mentor
    "mentee",       # open to being mentored
    "hobby_group",
    "friend",
)

#: Communication pacing.
PACE = ("async", "mixed", "sync")
GROUP_SIZE = ("one_on_one", "small", "large")
CHANNELS = ("text", "voice", "video", "in_person")

#: Peer compatibility: both people want the same kind of relationship.
#: Unlisted pairs score 0.0 — an unmodelled combination is not a match.
PEER: dict[tuple[str, str], float] = {
    ("friend", "friend"): 1.00,
    ("friend", "hobby_group"): 0.70,
    ("friend", "collaborator"): 0.55,
    ("cofounder", "cofounder"): 1.00,
    ("cofounder", "collaborator"): 0.85,
    ("collaborator", "collaborator"): 0.90,
    ("collaborator", "hobby_group"): 0.60,
    ("study_partner", "study_partner"): 1.00,
    ("study_partner", "collaborator"): 0.60,
    ("study_partner", "accountability"): 0.65,
    ("study_partner", "friend"): 0.50,
    ("accountability", "accountability"): 1.00,
    ("accountability", "collaborator"): 0.55,
    ("hobby_group", "hobby_group"): 0.90,
    # mentor <-> mentee is the one intentionally complementary pair
    ("mentor", "mentee"): 1.00,
    ("mentor", "study_partner"): 0.45,
    ("mentee", "study_partner"): 0.35,
    ("mentee", "collaborator"): 0.40,
    # two people who both want a mentor are not each other's answer
    ("mentor", "mentor"): 0.10,
    ("mentee", "mentee"): 0.10,
}

#: Fill compatibility: A *wants* x, B *offers* y. Can B actually fill the role?
FILL: dict[tuple[str, str], float] = {
    ("friend", "friend"): 1.00,
    ("cofounder", "cofounder"): 1.00,
    ("collaborator", "collaborator"): 1.00,
    ("study_partner", "study_partner"): 1.00,
    ("accountability", "accountability"): 1.00,
    ("hobby_group", "hobby_group"): 1.00,
    ("mentor", "mentor"): 1.00,
    ("mentee", "mentee"): 1.00,
    ("collaborator", "cofounder"): 0.80,
    ("cofounder", "collaborator"): 0.75,
    ("study_partner", "accountability"): 0.60,
    ("accountability", "study_partner"): 0.55,
    ("friend", "hobby_group"): 0.65,
    ("hobby_group", "friend"): 0.65,
    ("study_partner", "mentor"): 0.70,
    ("collaborator", "mentor"): 0.55,
    ("friend", "collaborator"): 0.40,
}

#: Canonical interest groups. Every alias collapses to the group name.
_SYNONYMS: dict[str, tuple[str, ...]] = {
    "ai": ("ai", "artificial-intelligence", "ml", "machine-learning", "llm", "llms",
           "gpt", "deep-learning", "neural-networks", "ai-agents", "agents", "rag",
           "fine-tuning", "transformers"),
    "security": ("security", "cybersecurity", "cybersec", "infosec", "appsec",
                 "hacking", "pentest", "pentesting", "reverse-engineering", "malware",
                 "forensics", "threat-modeling", "privacy", "cryptography",
                 "detection-engineering", "blue-team", "red-team"),
    "python": ("python", "python3", "pandas", "numpy", "fastapi", "django", "flask"),
    "web": ("web", "frontend", "front-end", "react", "nextjs", "svelte", "vue",
            "html", "css", "tailwind", "browser"),
    "typescript": ("typescript", "javascript", "node", "nodejs", "deno", "bun"),
    "systems": ("systems", "go", "golang", "rust", "c", "cpp", "c++", "zig",
                "compilers", "operating-systems", "kernel", "performance"),
    "infra": ("infra", "infrastructure", "devops", "cloud", "kubernetes", "docker",
              "terraform", "aws", "gcp", "azure", "cloudflare", "sre", "self-hosting",
              "homelab", "nix"),
    "data": ("data", "data-engineering", "analytics", "pipelines", "etl", "dbt",
             "warehouse", "visualization", "dataviz", "statistics"),
    "robotics": ("robotics", "uav", "drones", "embedded", "hardware", "arduino",
                 "esp32", "firmware", "pcb", "3d-printing", "cad", "sensors"),
    "writing": ("writing", "fiction", "essays", "blogging", "journalism",
                "newsletter", "poetry", "documentation"),
    "music": ("music", "guitar", "piano", "production", "synth", "band", "drums",
              "songwriting", "ableton"),
    "fitness": ("fitness", "running", "marathon", "strength", "cycling", "climbing",
                "lifting", "swimming", "yoga"),
    "language": ("language", "languages", "spanish", "japanese", "french", "german",
                 "italian", "korean", "mandarin", "portuguese", "latin", "esperanto"),
    "osint": ("osint", "research", "investigation", "threat-intel", "geolocation",
              "verification", "fact-checking", "satellite-imagery"),
    "design": ("design", "ui", "ux", "product-design", "figma", "typography",
               "illustration", "branding"),
    "startups": ("startups", "startup", "founder", "founding", "entrepreneurship",
                 "indie-hacking", "saas", "go-to-market", "fundraising"),
    "open-source": ("open-source", "oss", "foss", "maintainer", "licensing"),
    "gaming": ("gaming", "games", "gamedev", "unity", "godot", "board-games",
               "tabletop", "ttrpg"),
    "film": ("film", "photography", "video", "editing", "cinematography", "podcast"),
    "philosophy": ("philosophy", "ethics", "policy", "law", "epistemology",
                   "effective-altruism", "rationality"),
    "education": ("education", "teaching", "tutoring", "curriculum", "learning-science"),
}

_LOOKUP: dict[str, str] = {}
for _canon, _aliases in _SYNONYMS.items():
    for _alias in _aliases:
        _LOOKUP[_alias] = _canon

#: The canonical interest groups, public so other services (the scout) can fold
#: free text onto the same vocabulary instead of inventing a second taxonomy.
GROUPS: tuple[str, ...] = tuple(_SYNONYMS)

_STRIP = re.compile(r"[^a-z0-9+#]+")
_SPACE = re.compile(r"\s+")


def normalize_tag(raw: object) -> str:
    """Lowercase, de-accent, hyphenate. Returns "" for non-strings."""
    if not isinstance(raw, str):
        return ""
    text = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode()
    text = text.lower().strip()
    text = _SPACE.sub("-", text)
    text = _STRIP.sub("-", text)
    return text.strip("-")


def canonical_tag(raw: object) -> str:
    """Map a free-text interest onto its canonical group, or keep it as-is."""
    tag = normalize_tag(raw)
    if not tag:
        return ""
    return _LOOKUP.get(tag, tag)


def canonical_set(values: Iterable[object]) -> set[str]:
    """Canonicalize a list of tags, dropping empties and duplicates."""
    out: set[str] = set()
    for value in values or ():
        tag = canonical_tag(value)
        if tag:
            out.add(tag)
    return out


def clean_role(raw: object) -> str | None:
    """Validate a looking_for / offers entry against the closed vocabulary."""
    tag = normalize_tag(raw)
    if not tag:
        return None
    tag = tag.replace("-", "_")
    if tag in LOOKING_FOR or tag in OFFERS:
        return tag
    # tolerate "study partner", "co-founder", "accountability partner"
    collapsed = tag.replace("_", "")
    aliases = {
        "cofounder": "cofounder",
        "cofounders": "cofounder",
        "cofoundersearch": "cofounder",
        "founder": "cofounder",
        "collaborator": "collaborator",
        "projectpartner": "collaborator",
        "buildpartner": "collaborator",
        "studypartner": "study_partner",
        "studybuddy": "study_partner",
        "accountabilitypartner": "accountability",
        "accountapartner": "accountability",
        "hobbygroup": "hobby_group",
        "group": "hobby_group",
        "mentor": "mentor",
        "mentee": "mentee",
        "friend": "friend",
        "friends": "friend",
    }
    return aliases.get(collapsed)
