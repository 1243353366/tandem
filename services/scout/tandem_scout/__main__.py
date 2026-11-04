"""Scout CLI.

    python -m tandem_scout --policy
    python -m tandem_scout --topics ai,security --live
    python -m tandem_scout --topics ai --replay test/fixtures

Live mode hits public endpoints. Replay mode reads a recorded
`observations.json`, which is what CI uses so the suite never depends on someone
else's uptime.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import policy, queue, sources
from .models import Observation

DEFAULT_OUT = Path(__file__).resolve().parents[3] / "data" / "scout"
DEFAULT_OPTOUT = Path(__file__).resolve().parents[3] / "data" / "scout" / "optout.txt"
INVITE_URL = "https://tandem.example/join"


def load_replay(directory: Path) -> list[Observation]:
    """Read a recorded observations file.

    Records may carry `age_days` instead of a fixed `created_at`, so recorded
    fixtures do not rot into "everything is stale" a year from now.
    """
    path = directory / "observations.json"
    if not path.exists():
        raise SystemExit(f"no observations.json in {directory}; nothing to replay")
    payload = json.loads(path.read_text())
    records = payload["observations"] if isinstance(payload, dict) else payload
    now = datetime.now(timezone.utc)

    out: list[Observation] = []
    for record in records:
        created_at = record.get("created_at", "")
        if "age_days" in record:
            created_at = (now - timedelta(days=float(record["age_days"]))).isoformat()
        out.append(
            Observation(
                source=record["source"],
                handle=record["handle"],
                text=record.get("text", ""),
                url=record.get("url", ""),
                created_at=created_at,
                topic=record.get("topic", ""),
                extra=record.get("extra", {}),
            )
        )
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tandem-scout", description="public-signal discovery for Tandem")
    parser.add_argument("--topics", default="ai,security", help="comma-separated topics to look for")
    parser.add_argument("--sources", default="hackernews,devto,github", help="comma-separated sources")
    parser.add_argument(
        "--channels", default="",
        help="comma-separated public group handles (e.g. @somechannel). A group is named by "
             "hand, never discovered. Private groups are refused.",
    )
    parser.add_argument("--limit", type=int, default=20, help="items per topic per source")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="output directory")
    parser.add_argument("--optout", default=str(DEFAULT_OPTOUT), help="opt-out list file")
    parser.add_argument("--cap", type=int, default=policy.MAX_INVITES_PER_RUN)
    parser.add_argument("--invite-url", default=INVITE_URL)
    parser.add_argument("--live", action="store_true", help="actually call public endpoints")
    parser.add_argument("--replay", metavar="DIR", help="read recorded observations instead of the network")
    parser.add_argument("--policy", action="store_true", help="print the discovery policy and exit")
    parser.add_argument("--json", action="store_true", help="print the queue as JSON")
    args = parser.parse_args(argv)

    if args.policy:
        print(json.dumps(policy.policy_summary(), indent=2))
        return 0

    topics = [t.strip() for t in args.topics.split(",") if t.strip()]
    source_names = [s.strip() for s in args.sources.split(",") if s.strip()]
    channels = [c.strip() for c in args.channels.split(",") if c.strip()]

    if not args.live and not args.replay:
        print(
            "refusing to guess: pass --live to call public endpoints, or --replay DIR to use recorded data.\n"
            "  python -m tandem_scout --topics ai,security --live",
            file=sys.stderr,
        )
        return 2

    reports: list[dict[str, str]] = []
    if args.replay:
        observations = load_replay(Path(args.replay))
        reports = [{"source": name, "status": "replay", "observations": str(len(observations)), "note": ""}
                   for name in source_names]
    else:
        observations, source_reports = sources.collect(
            topics, source_names, limit_per_topic=args.limit, pause_seconds=0.4,
            channels=channels,
        )
        reports = [asdict(report) for report in source_reports]

    optouts = policy.load_optouts(Path(args.optout))
    generated_at = datetime.now(timezone.utc).isoformat()
    candidates, stats = queue.build_queue(
        observations,
        topics,
        optouts=optouts,
        cap=args.cap,
        invite_url=args.invite_url,
    )

    groups = queue.build_group_digest(observations, topics)
    paths = queue.write_outputs(
        Path(args.out), candidates, stats, reports, topics, generated_at, groups=groups
    )

    if args.json:
        print(json.dumps([candidate.to_json() for candidate in candidates], indent=2))
    else:
        print(f"scanned {stats['seen']} public items across {len(reports)} source(s)")
        print(
            f"queue {stats['queued']} · stale {stats['stale']} · opted out {stats['opted_out']} · "
            f"too thin {stats['too_thin']} · group signals {stats['group_signal']}"
        )
        for report in reports:
            print(f"  {report['source']:<11} {report['status']:<9} {report['observations']:>3}  {report.get('note', '')}")
        print()
        for candidate in candidates[:8]:
            print(f"  {candidate.priority:.2f}  {candidate.handle:<20} {candidate.source:<11} "
                  f"{', '.join(candidate.interests[:3])}")
        if not candidates:
            print("  (nothing cleared the bar this run)")
        if groups:
            print()
            print("  public groups (community list, not invites):")
            for group in groups[:6]:
                quiet = " (quiet)" if group["quiet"] else ""
                print(f"    {group['source']}:{group['handle']}{quiet}  "
                      f"{group['posts_per_week']}/7d  {', '.join(group['interests'][:3])}")
        print(f"\nwrote {paths['digest']}\n      {paths['queue']}\n      {paths['groups']}")
        print("\nread the digest and post one or two replies yourself. not more.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
