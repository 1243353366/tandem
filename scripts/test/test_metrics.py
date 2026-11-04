import unittest
from datetime import datetime

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import metrics  # noqa: E402


def commit(sha, at, subject, change=None, fix=None):
    return metrics.Commit(
        sha=sha,
        at=datetime.fromisoformat(at),
        subject=subject,
        change=change,
        fix_after_merge=fix,
    )


class TrailerTests(unittest.TestCase):
    def test_trailers_are_read_from_the_body(self):
        body = "Some explanation.\n\nChange: review-pass-3\nFix-After-Merge: 47fd058\n"
        found = metrics.parse_trailers(body)
        self.assertEqual(found["change"], "review-pass-3")
        self.assertEqual(found["fix-after-merge"], "47fd058")

    def test_ordinary_text_containing_a_colon_is_not_a_trailer(self):
        self.assertEqual(metrics.parse_trailers("note: this is prose\n"), {})


class SummaryTests(unittest.TestCase):
    def test_correction_cycles_count_commits_after_the_first(self):
        commits = [
            commit("a1", "2026-01-01T10:00:00+00:00", "add thing", change="thing"),
            commit("a2", "2026-01-01T11:00:00+00:00", "fix thing", change="thing"),
            commit("a3", "2026-01-01T12:00:00+00:00", "fix thing again", change="thing"),
            commit("b1", "2026-01-02T10:00:00+00:00", "add other", change="other"),
        ]
        out = metrics.summarize(commits, [])
        self.assertEqual(out.correction_detail, {"thing": 2, "other": 0})
        self.assertEqual(sum(out.correction_cycles) / len(out.correction_cycles), 1.0)

    def test_a_defect_after_merge_is_counted_once_from_ledger(self):
        ledger = [{"kind": "defect_after_merge", "introduced_by": "a1", "found_in": "a2", "defect": "x"}]
        out = metrics.summarize([], ledger)
        self.assertEqual(out.defects_after_merge, 1)
        self.assertIn("a2 repairs a1", out.defect_evidence[0])

    def test_time_to_verified_uses_the_recorded_start_and_completion(self):
        commits = [commit("a1", "2026-01-01T10:00:00+00:00", "add", change="thing")]
        ledger = [{"kind": "verified", "change": "thing", "at": "2026-01-01T13:30:00+00:00"}]
        out = metrics.summarize(commits, ledger)
        self.assertAlmostEqual(out.time_to_verified_hours[0], 3.5)

    def test_no_evidence_is_not_zero(self):
        out = metrics.summarize([], [])
        self.assertEqual(out.as_dict()["average_correction_cycles_per_change"]["average"], None)
        self.assertEqual(out.as_dict()["time_to_verified_completion_hours"]["average"], None)


if __name__ == "__main__":
    unittest.main()
