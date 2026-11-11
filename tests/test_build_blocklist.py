import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import build_blocklist as bb  # noqa: E402

GOOD = {"v": 1, "target": "event", "id": 70, "problem": "exclude",
        "reason": "abroad", "comment": "Paris", "event_id": 70}


class CheckRecord(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(bb.check_record(GOOD), [])

    def test_problems(self):
        cases = [
            ({**GOOD, "target": "nope"}, "unknown target"),
            ({**GOOD, "problem": "wrong_actor"}, "does not apply"),
            ({**GOOD, "id": "70"}, "id must be"),
            ({**GOOD, "id": True}, "id must be"),
            ({**GOOD, "reason": "bored"}, "unknown reason"),
            ({**GOOD, "comment": "x" * 501}, "over 500"),
            ({**GOOD, "extra": 1}, "unknown fields"),
            ({k: v for k, v in GOOD.items() if k != "id"}, "missing 'id'"),
            ([1], "not a JSON object"),
        ]
        for record, message in cases:
            errors = bb.check_record(record)
            self.assertTrue(any(message in e for e in errors), (record, errors))


class Build(unittest.TestCase):
    def test_reports_are_combined_and_bad_lines_named(self):
        with tempfile.TemporaryDirectory() as tmp:
            reports = Path(tmp) / "reports"
            reports.mkdir()
            (reports / "a.jsonl").write_text(json.dumps(GOOD) + "\n\n{bad\n")
            (reports / "b.jsonl").write_text(json.dumps({**GOOD, "id": 71}))
            (reports / "notes.txt").write_text("x")
            records, errors = bb.read_reports(reports)
            self.assertEqual([r["id"] for r in records], [70, 71])
            self.assertEqual(records[0]["source"], "reports/a.jsonl")
            self.assertEqual(len(errors), 2)
            self.assertIn("reports/a.jsonl:3", errors[0])

            out = Path(tmp) / "site" / "blocklist.jsonl"
            self.assertEqual(
                bb.main(["--reports", str(reports), "--out", str(out)]), 0
            )
            self.assertEqual(len(out.read_text().splitlines()), 2)
            self.assertEqual(bb.main(["--reports", str(reports), "--check"]), 1)

    def test_shipped_reports_are_valid(self):
        self.assertEqual(bb.read_reports(bb.ROOT / "reports")[1], [])


if __name__ == "__main__":
    unittest.main()
