import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  indexReports,
  isExcluded,
  makeRecord,
  packForGitHub,
  parseBlocklist,
  reportCount,
  reportFileName,
} from "../js/reports.js";

const schema = JSON.parse(
  readFileSync(new URL("../schema.json", import.meta.url), "utf8"),
);

test("every problem a target allows has a label", () => {
  for (const spec of Object.values(schema.targets)) {
    for (const p of spec.problems) assert.ok(schema.problems[p], p);
  }
});

test("records keep only what was given and trim the comment", () => {
  const r = makeRecord(schema, {
    target: "event",
    id: 70,
    problem: "exclude",
    reason: "abroad",
    comment: "  in Paris  ",
    authoritative_event_id: 7,
    event_id: 70,
    release: "data-export-2026-11-11",
    file: "x.tsv",
  });
  assert.deepEqual(r, {
    v: 1,
    target: "event",
    id: 70,
    problem: "exclude",
    reason: "abroad",
    comment: "in Paris",
    authoritative_event_id: 7,
    event_id: 70,
    release: "data-export-2026-11-11",
    file: "x.tsv",
  });
  assert.throws(
    () => makeRecord(schema, { target: "actor", id: 1, problem: "exclude" }),
    /not a problem/,
  );
});

test("report file names are dated and random", () => {
  const name = reportFileName(new Date("2026-11-11T10:00:00Z"), () => 0.5);
  assert.match(name, /^reports\/2026-11-11-[0-9a-z]{6}\.jsonl$/);
});

test("long baskets are split to keep the GitHub link short", () => {
  const records = Array.from({ length: 200 }, (_, i) =>
    makeRecord(schema, {
      target: "event",
      id: i + 1,
      problem: "other",
      comment: "x".repeat(200),
    }),
  );
  const { url, count } = packForGitHub(schema.repo, records, "reports/a.jsonl");
  assert.ok(count > 0 && count < 200);
  assert.ok(url.length <= 7000);
  const value = new URL(url).searchParams.get("value");
  assert.equal(value.trim().split("\n").length, count);
  assert.equal(new URL(url).searchParams.get("filename"), "reports/a.jsonl");
});

test("exclusion: the gathering, or all of its reports", () => {
  const index = indexReports(
    parseBlocklist(
      [
        '{"target":"authoritative_event","id":7,"problem":"exclude"}',
        '{"target":"event","id":80,"problem":"exclude"}',
        '{"target":"event","id":81,"problem":"wrong_date"}',
        "not json",
      ].join("\n"),
    ),
  );
  const ev = (aeId, ids) => ({
    aeId,
    reports: ids.map((eventId) => ({ eventId, actors: [] })),
  });
  assert.equal(isExcluded(index, ev(7, [1])), true);
  assert.equal(isExcluded(index, ev(null, [80])), true);
  assert.equal(isExcluded(index, ev(8, [80, 81])), false);
  assert.equal(reportCount(index, ev(8, [80, 81])), 2);
});
