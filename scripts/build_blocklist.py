#!/usr/bin/env python3
"""Check the report files and combine them into blocklist.jsonl.

Every file in reports/ holds one JSON object per line, written by the
reviewer app. --check validates them (run on pull requests); otherwise
the valid reports are written, in file order, to --out with a "source"
field naming their file. Standard library only.
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = json.loads((ROOT / "schema.json").read_text(encoding="utf-8"))
REQUIRED = ("v", "target", "id", "problem")
OPTIONAL = (
    "reason",
    "comment",
    "authoritative_event_id",
    "event_id",
    "release",
    "file",
)


def _positive_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def check_record(record) -> list[str]:
    """Problems with one report; empty when it is valid."""
    if not isinstance(record, dict):
        return ["not a JSON object"]
    errors = [f"missing {k!r}" for k in REQUIRED if k not in record]
    unknown = set(record) - set(REQUIRED) - set(OPTIONAL)
    if unknown:
        errors.append(f"unknown fields {sorted(unknown)}")
    if errors:
        return errors
    if record["v"] != SCHEMA["version"]:
        errors.append(f"version must be {SCHEMA['version']}")
    target = SCHEMA["targets"].get(record["target"])
    if target is None:
        errors.append(f"unknown target {record['target']!r}")
    elif record["problem"] not in target["problems"]:
        errors.append(
            f"problem {record['problem']!r} does not apply to "
            f"{record['target']!r}"
        )
    if not _positive_int(record["id"]):
        errors.append("id must be a positive whole number")
    for key in ("authoritative_event_id", "event_id"):
        if key in record and not _positive_int(record[key]):
            errors.append(f"{key} must be a positive whole number")
    if "reason" in record and record["reason"] not in SCHEMA["reasons"]:
        errors.append(f"unknown reason {record['reason']!r}")
    for key in ("comment", "release", "file"):
        if key in record and not isinstance(record[key], str):
            errors.append(f"{key} must be text")
    if len(record.get("comment") or "") > SCHEMA["comment_max"]:
        errors.append(f"comment is over {SCHEMA['comment_max']} characters")
    return errors


def read_reports(reports_dir: Path):
    """(records, errors) over every reports/*.jsonl file."""
    records, errors = [], []
    for path in sorted(reports_dir.glob("*.jsonl")):
        name = path.relative_to(reports_dir.parent).as_posix()
        lines = path.read_text(encoding="utf-8").splitlines()
        for number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as e:
                errors.append(f"{name}:{number}: not valid JSON ({e.msg})")
                continue
            problems = check_record(record)
            if problems:
                errors.extend(f"{name}:{number}: {p}" for p in problems)
            else:
                records.append({**record, "source": name})
    for path in sorted(reports_dir.iterdir()):
        if path.is_file() and path.suffix != ".jsonl" and path.name != "README.md":
            errors.append(f"{path.name}: report files must end in .jsonl")
    return records, errors


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--reports", type=Path, default=ROOT / "reports")
    parser.add_argument("--out", type=Path, default=Path("blocklist.jsonl"))
    args = parser.parse_args(argv)

    records, errors = read_reports(args.reports)
    for error in errors:
        print(error, file=sys.stderr)
    if args.check:
        print(f"{len(records)} valid reports, {len(errors)} problems")
        return 1 if errors else 0
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    print(f"wrote {len(records)} reports to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
