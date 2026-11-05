"""An evidence log with no ceiling is a way to fill a disk by trying."""

import json
import tempfile
import unittest
from pathlib import Path

from tandem_scout import injection


class RotationTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.log = injection.InjectionLog(self.dir / "injection-log.jsonl", self.dir / "q.json")

    def _attempt(self, url="https://github.com/x/1"):
        return injection.Attempt(rule="override", source="github", url=url, excerpt="ignore all previous", at="2026-11-04T00:00:00Z")

    def test_rotates_once_the_log_passes_its_ceiling(self):
        original = injection.LOG_MAX_BYTES
        injection.LOG_MAX_BYTES = 200
        try:
            for index in range(6):
                self.log.record(self._attempt(f"https://github.com/x/{index}"))
            previous = self.dir / "injection-log.jsonl.1"
            self.assertTrue(previous.exists(), "the previous generation is kept")
            # rotation happens before the next write, so the file can hold the ceiling plus
            # the one record that pushed it over. Bounded, not exact.
            self.assertLess(
                self.log.log_path.stat().st_size,
                injection.LOG_MAX_BYTES + 400,
                "the log cannot grow without limit",
            )
        finally:
            injection.LOG_MAX_BYTES = original

    def test_rotation_drops_the_oldest_lines_and_keeps_the_rest(self):
        """A size cap has to lose something. It loses the oldest, and that is stated, not hidden."""
        original = injection.LOG_MAX_BYTES
        injection.LOG_MAX_BYTES = 200
        try:
            for index in range(6):
                self.log.record(self._attempt(f"https://github.com/x/{index}"))
            lines = []
            for path in (self.dir / "injection-log.jsonl.1", self.log.log_path):
                lines += [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
            urls = {entry["url"] for entry in lines}
            self.assertIn("https://github.com/x/5", urls, "the newest attempt is always kept")
            self.assertGreaterEqual(len(urls), 2, "evidence survives the rotation")
            self.assertTrue(
                (self.dir / "injection-log.jsonl.1").exists(),
                "the previous generation is kept, so the drop is bounded and visible",
            )
        finally:
            injection.LOG_MAX_BYTES = original


if __name__ == "__main__":
    unittest.main()
