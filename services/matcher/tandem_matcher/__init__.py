"""Tandem matching engine — pure Python, no third-party dependencies."""

from .scoring import (  # noqa: F401
    DISPLAY_FLOOR,
    ENGINE_VERSION,
    ONEWAY_CAP,
    UNVERIFIED_CAP,
    WEIGHTS,
    Profile,
    Score,
    match,
    score_pair,
    utc_offset_hours,
)
from . import vocab  # noqa: F401

__all__ = [
    "DISPLAY_FLOOR",
    "ENGINE_VERSION",
    "ONEWAY_CAP",
    "UNVERIFIED_CAP",
    "WEIGHTS",
    "Profile",
    "Score",
    "match",
    "score_pair",
    "utc_offset_hours",
    "vocab",
]
