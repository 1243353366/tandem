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
import os
import sys
import urllib.error
import urllib.request
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import injection, members as member_mod
from . import policy, queue, sources
from .models import Observation

DEFAULT_OUT = Path(__file__).resolve().parents[3] / "data" / "scout"
DEFAULT_OPTOUT = Path(__file__).resolve().parents[3] / "data" / "scout" / "optout.txt"
INVITE_URL = "https://tandem.example/join"


def _service_call(url: str, token: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode())


def run_members(args) -> int:
    """Read the accounts members declared themselves, and store what they imply.

    This is the consented path. Nothing here searches for anyone: the handle list
    comes from the API, and every entry was typed by the person it belongs to.
    """
    base = args.api.rstrip("/")
    try:
        listing = _service_call(f"{base}/v1/service/members", args.service_token)
    except (urllib.error.URLError, OSError) as exc:
        print(
            f"could not reach the API at {base} ({exc}).\n"
            "start it with `make dev`, or pass --api. In production these two endpoints "
            "also need TANDEM_SERVICE_TOKEN.",
            file=sys.stderr,
        )
        return 2
    members = listing.get("members", [])
    if not members:
        print("no members have declared a readable handle yet (this is the normal first run)")
        return 0

    handles = [
        member_mod.MemberHandle(person["person_id"], handle["network"], handle["handle"])
        for person in members
        for handle in person.get("handles", [])
    ]
    results = [member_mod.enrich_member(handle) for handle in handles]
    merged = member_mod.merge_member_signals(results)

    stored = 0
    for person_id, derived in merged.items():
        for error in derived.errors:
            print(f"  {person_id[:8]}  {error}")
        if not derived.interests:
            continue
        response = _service_call(
            f"{base}/v1/service/members/{person_id}/signals", args.service_token, derived.to_payload()
        )
        stored += int(response.get("stored", 0))
        print(
            f"  {person_id[:8]}  {derived.observations:>3} item(s)  "
            f"{', '.join(derived.interests[:4])}  ({'+'.join(derived.sources) or 'none'})"
        )

    print(f"\nread {len(handles)} declared handle(s) from {len(members)} member(s); stored {stored} signal(s)")
    print("revoking a handle removes every signal derived from it, in the same transaction")
    return 0


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
    parser.add_argument(
        "--members", action="store_true",
        help="read the declared handles of consenting members and store their signals "
             "(the consented path: no stranger scanning)",
    )
    parser.add_argument("--api", default="http://127.0.0.1:8080", help="API base for --members")
    parser.add_argument("--service-token", default=os.environ.get("TANDEM_SERVICE_TOKEN", ""))
    parser.add_argument("--json", action="store_true", help="print the queue as JSON")
    args = parser.parse_args(argv)

    if args.policy:
        print(json.dumps(policy.policy_summary(), indent=2))
        return 0

    if args.members:
        return run_members(args)

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
        recorded = load_replay(Path(args.replay))
        observations = []
        for record in recorded:
            try:
                injection.DEFAULT.guard(record.text, source=record.source, url=record.url)
            except injection.InjectionRefused as refused:
                print(f"dropped a recorded item from {refused.attempt.source}: {refused.attempt.rule}; "
                      f"logged to {injection.DEFAULT.log_path.name}", file=sys.stderr)
                continue
            observations.append(record)
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
