import assert from "node:assert/strict";
import { test } from "node:test";

import { EventStore, TsvParser, releaseFromFileName } from "../js/tsv.js";

function parse(chunks) {
  const rows = [];
  const parser = new TsvParser((r) => rows.push(r));
  for (const c of chunks) parser.push(c);
  parser.end();
  return rows;
}

test("quoted fields keep tabs out and line breaks in", () => {
  const text = '"a"\t"b"\n1\t"two\nlines"\n\t"x"\n';
  assert.deepEqual(parse([text]), [
    ["a", "b"],
    ["1", "two\nlines"],
    ["", "x"],
  ]);
});

test("chunk boundaries anywhere give the same rows", () => {
  const text = '"h1"\t"h2"\n12\t"quoted\ttext"\n3.5\t""\n';
  const whole = parse([text]);
  for (let i = 1; i < text.length; i++) {
    assert.deepEqual(parse([text.slice(0, i), text.slice(i)]), whole);
  }
});

test("a missing final newline still ends the row", () => {
  assert.deepEqual(parse(['"a"\n1']), [["a"], ["1"]]);
});

const HEADER = [
  "authoritative_event_id",
  "authoritative_date_start",
  "authoritative_location",
  "article_journal",
  "event_id",
  "event_excerpt",
  "type",
  "actor",
  "actor_id",
  "authoritative_actor",
  "authoritative_actor_id",
];

function store(rows) {
  const s = new EventStore(HEADER);
  for (const r of rows) s.add(r);
  return s.finish();
}

test("rows group into gatherings, reports and distinct actors", () => {
  const events = store([
    ["7", "1890-05-01", "Malmö", "Arbetet", "70", "text a", "möte", "Folket", "1", "folket", "9"],
    ["7", "1890-05-01", "Malmö", "Arbetet", "70", "text a", "möte", "Folket", "1", "folket", "9"],
    ["7", "1890-05-01", "Malmö", "Arbetet", "70", "text a", "möte", "Talare", "2", "", ""],
    ["7", "1890-05-01", "Malmö", "DN", "71", "text b", "möte", "", "", "", ""],
    ["", "", "", "GHT", "80", "internal", "möte", "", "", "", ""],
    ["5", "1880-01-02", "Lund", "DN", "50", "c", "folkmöte", "", "", "", ""],
  ]);
  assert.deepEqual(
    events.map((e) => e.key),
    ["g5", "g7", "r80"],
  );
  const g7 = events[1];
  assert.equal(g7.reports.length, 2);
  assert.deepEqual(
    g7.reports[0].actors.map((a) => [a.id, a.authId]),
    [
      [1, 9],
      [2, null],
    ],
  );
  assert.deepEqual(g7.journals, ["Arbetet", "DN"]);
  assert.equal(g7.year, 1890);
  assert.ok(g7.haystack.includes("malmö"));
  assert.equal(events[2].aeId, null);
});

test("a file without the id columns is refused", () => {
  assert.throws(() => new EventStore(["a", "b"]), /not an elsa export/);
});

test("release tag from the file name", () => {
  assert.equal(
    releaseFromFileName("elsa_export_2026-11-11_w_prerelease.tsv.zip"),
    "data-export-2026-11-11",
  );
  assert.equal(releaseFromFileName("other.tsv"), null);
});
