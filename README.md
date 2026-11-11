# Elsa reviewer

A web page for reviewing the gatherings that
[elsa](https://github.com/ContentiousGatherings/elsa) finds in Swedish
newspapers, and reporting what is wrong with them.

**Use it at <https://contentiousgatherings.github.io/elsa-reviewer/>.**

1. Download an export file (`elsa_export_….tsv.zip`) from the
   [elsa releases](https://github.com/ContentiousGatherings/elsa/releases).
2. Open it in the page. The file never leaves your computer. Large files
   (`full`) take a while to open and need a computer with plenty of memory;
   a single newspaper or decade opens in seconds.
3. Browse. When something is wrong, press **Report a problem** on the
   gathering, the newspaper report or the actor, and say what is wrong.
4. Press **My reports**, then **Send to GitHub**. GitHub opens with your
   reports filled in as a new file; log in if asked, press
   **Commit changes…** / **Propose changes**, then **Create pull request**.

## Reviewing reports

Each pull request adds one file to `reports/`, one report per line. A check
confirms the format; reviewers judge the content and merge. After a merge
the site is rebuilt and `blocklist.jsonl` (every merged report, with the
file it came from) is published next to the page:
<https://contentiousgatherings.github.io/elsa-reviewer/blocklist.jsonl>.
The page hides gatherings reported as *should not be included* (there is a
switch to show them), and elsa reads the same list when it builds exports.

## Report format

```json
{"v": 1, "target": "event", "id": 8362, "problem": "wrong_date",
 "comment": "Article is from 1892, not 1893",
 "authoritative_event_id": 42196, "event_id": 8362,
 "release": "data-export-2026-11-11", "file": "elsa_export_…tsv"}
```

| field | meaning |
|---|---|
| `target` | `authoritative_event` (a gathering), `event` (one newspaper report) or `actor` |
| `id` | the id of that item in elsa |
| `problem` | what is wrong; the allowed values per target are in `schema.json` |
| `reason` | for `exclude`: why it should not be included (optional) |
| `comment` | the reviewer's words, at most 500 characters (optional) |
| `authoritative_event_id`, `event_id` | where the item was found |
| `release`, `file` | the export the reviewer was looking at |

`schema.json` is the single list of targets, problems and reasons, read by
both the page and `scripts/build_blocklist.py`.

## Development

Plain HTML and JavaScript, no build step. Serve the folder with any static
server (`python -m http.server`) and open it. Tests:

```sh
node --test tests/
python -m unittest discover -s tests -p "test_*.py"
python scripts/build_blocklist.py --check
```

## Repository settings

- **Pages:** Settings → Pages → Source: *GitHub Actions*.
- **Branch protection on `main`:** require a pull request with one
  approval and the *Check reports* check, so every report is reviewed.
