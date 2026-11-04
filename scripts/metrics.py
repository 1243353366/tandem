#!/usr/bin/env python3
"""Three numbers about how this project actually goes, from evidence.

    python3 scripts/metrics.py           # all three, with what each is based on
    python3 scripts/metrics.py --json

Nothing here is a guess. The ledger (metrics/ledger.jsonl) holds events that happened,
each naming the commit it refers to, and git holds the timestamps. Where there is not
enough evidence the answer is "not enough data", not zero: a metric that reports 0
because nobody recorded anything is worse than no metric.

Conventions, so the numbers keep working:

  Change: <id>            trailer on every commit of one piece of work
  Fix-After-Merge: <sha>  trailer on a commit that repairs something already merged
  ledger kinds            change_started, defect_after_merge, verified
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / "metrics" / "ledger.jsonl"


@dataclass
class Commit:
    sha: str
    at: datetime
    subject: str
    change: str | None = None
    fix_after_merge: str | None = None


@dataclass
class Metrics:
    defects_after_merge: int = 0
    defect_evidence: list[str] = field(default_factory=list)
    correction_cycles: list[int] = field(default_factory=list)
    correction_detail: dict[str, int] = field(default_factory=dict)
    time_to_verified_hours: list[float] = field(default_factory=list)
    verified_detail: dict[str, float] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "defects_discovered_after_merge": {
                "count": self.defects_after_merge,
                "evidence": self.defect_evidence,
            },
            "average_correction_cycles_per_change": {
                "average": round(sum(self.correction_cycles) / len(self.correction_cycles), 2)
                if self.correction_cycles
                else None,
                "changes": len(self.correction_cycles),
                "detail": self.correction_detail,
            },
            "time_to_verified_completion_hours": {
                "average": round(sum(self.time_to_verified_hours) / len(self.time_to_verified_hours), 2)
                if self.time_to_verified_hours
                else None,
                "changes": len(self.time_to_verified_hours),
                "detail": self.verified_detail,
            },
        }


def parse_trailers(body: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for line in body.splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip().lower()
        if key in ("change", "fix-after-merge"):
            found[key] = value.strip()
    return found


def parse_log(raw: str) -> list[Commit]:
    commits: list[Commit] = []
    for record in raw.split("\x1e"):
        record = record.strip("\n")
        if not record:
            continue
        parts = record.split("\x1f")
        if len(parts) < 4:
            continue
        sha, at, subject, body = parts[0], parts[1], parts[2], parts[3]
        trailers = parse_trailers(body)
        commits.append(
            Commit(
                sha=sha,
                at=datetime.fromisoformat(at),
                subject=subject,
                change=trailers.get("change"),
                fix_after_merge=trailers.get("fix-after-merge"),
            )
        )
    return commits


def read_ledger(path: Path = LEDGER) -> list[dict]:
    if not path.exists():
        return []
    events = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def summarize(commits: list[Commit], ledger: list[dict]) -> Metrics:
    out = Metrics()

    # 1. defects discovered after merge
    for commit in commits:
        if commit.fix_after_merge:
            out.defects_after_merge += 1
            out.defect_evidence.append(f"{commit.sha[:7]} repairs {commit.fix_after_merge[:7]}: {commit.subject}")
    for event in ledger:
        if event.get("kind") != "defect_after_merge":
            continue
        out.defects_after_merge += 1
        out.defect_evidence.append(
            f"{event.get('found_in', '?')[:7]} repairs {event.get('introduced_by', '?')[:7]}"
            f" ({event.get('found_by', 'review')}): {event.get('defect', '')}"
        )

    # 2. correction cycles: commits after the first one, per change
    by_change: dict[str, list[Commit]] = {}
    for commit in commits:
        if commit.change:
            by_change.setdefault(commit.change, []).append(commit)
    for change, group in by_change.items():
        cycles = max(0, len(group) - 1)
        out.correction_cycles.append(cycles)
        out.correction_detail[change] = cycles

    # 3. initial implementation to verified completion
    started: dict[str, datetime] = {}
    for commit in commits:
        if commit.change:
            earliest = started.get(commit.change)
            if earliest is None or commit.at < earliest:
                started[commit.change] = commit.at
    for event in ledger:
        if event.get("kind") == "change_started" and event.get("change"):
            started[event["change"]] = datetime.fromisoformat(event["at"])
    for event in ledger:
        if event.get("kind") != "verified" or not event.get("change"):
            continue
        began = started.get(event["change"])
        if began is None:
            continue
        hours = (datetime.fromisoformat(event["at"]) - began).total_seconds() / 3600
        out.time_to_verified_hours.append(hours)
        out.verified_detail[event["change"]] = round(hours, 2)

    return out


def git_log(root: Path = ROOT) -> list[Commit]:
    try:
        raw = subprocess.run(
            ["git", "log", "--format=%H%x1f%aI%x1f%s%x1f%b%x1e", "--no-merges"],
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return []
    return parse_log(raw)


def main(argv: list[str]) -> int:
    commits = git_log()
    metrics = summarize(commits, read_ledger())
    payload = metrics.as_dict()
    if "--json" in argv:
        print(json.dumps(payload, indent=2))
        return 0

    first = payload["defects_discovered_after_merge"]
    second = payload["average_correction_cycles_per_change"]
    third = payload["time_to_verified_completion_hours"]

    print(f"commits read: {len(commits)}  ledger events: {len(read_ledger())}")
    print()
    print(f"defects discovered after merge          {first['count']}")
    for line in first["evidence"]:
        print(f"  {line}")
    if second["average"] is None:
        print("\naverage correction cycles per change    not enough data (no `Change:` trailers)")
    else:
        print(f"\naverage correction cycles per change    {second['average']} over {second['changes']} change(s)")
        for change, cycles in sorted(second["detail"].items()):
            print(f"  {change}: {cycles}")
    if third["average"] is None:
        print("\ntime to verified completion             not enough data (no verified events)")
    else:
        print(f"\ntime to verified completion             {third['average']}h over {third['changes']} change(s)")
        for change, hours in sorted(third["detail"].items()):
            print(f"  {change}: {hours}h")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
