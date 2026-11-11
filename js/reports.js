// Problem reports: building them, sending them to GitHub, and matching
// the merged ones (blocklist.jsonl) against the data.

const MAX_URL = 7000;

export function makeRecord(schema, fields) {
  const { target, id, problem } = fields;
  const spec = schema.targets[target];
  if (!spec) throw new Error("unknown target " + target);
  if (!spec.problems.includes(problem)) {
    throw new Error(`${problem} is not a problem for a ${target}`);
  }
  const record = { v: schema.version, target, id, problem };
  if (fields.reason) record.reason = fields.reason;
  const comment = (fields.comment || "").trim().slice(0, schema.comment_max);
  if (comment) record.comment = comment;
  for (const key of ["authoritative_event_id", "event_id"]) {
    if (fields[key] != null) record[key] = fields[key];
  }
  if (fields.release) record.release = fields.release;
  if (fields.file) record.file = fields.file;
  return record;
}

export function reportFileName(now = new Date(), random = Math.random) {
  const day = now.toISOString().slice(0, 10);
  const tag = Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
  return `reports/${day}-${tag}.jsonl`;
}

export function newFileUrl(repo, path, content) {
  const q = (s) => encodeURIComponent(s);
  return `https://github.com/${repo}/new/main?filename=${q(path)}&value=${q(content)}`;
}

// The longest leading run of records whose GitHub link stays short
// enough for browsers and GitHub; the rest wait for the next send.
export function packForGitHub(repo, records, path) {
  let count = records.length;
  while (count > 0) {
    const content = records
      .slice(0, count)
      .map((r) => JSON.stringify(r))
      .join("\n");
    const url = newFileUrl(repo, path, content + "\n");
    if (url.length <= MAX_URL || count === 1) return { url, count };
    count = Math.max(1, Math.floor(count * 0.7));
  }
  return { url: null, count: 0 };
}

export function parseBlocklist(text) {
  const records = [];
  for (const line of (text || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A bad line never hides data; the check in the repo rejects them.
    }
  }
  return records;
}

export function indexReports(records) {
  const index = new Map();
  for (const r of records) {
    const key = r.target + ":" + r.id;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(r);
  }
  return index;
}

export function reportsFor(index, target, id) {
  return id == null ? [] : index.get(target + ":" + id) || [];
}

// A gathering is excluded when it, or every one of its newspaper
// reports, was reported as "should not be included".
export function isExcluded(index, ev) {
  const excluded = (target, id) =>
    reportsFor(index, target, id).some((r) => r.problem === "exclude");
  if (excluded("authoritative_event", ev.aeId)) return true;
  return (
    ev.reports.length > 0 &&
    ev.reports.every((rep) => excluded("event", rep.eventId))
  );
}

export function reportCount(index, ev) {
  let n = reportsFor(index, "authoritative_event", ev.aeId).length;
  for (const rep of ev.reports) {
    n += reportsFor(index, "event", rep.eventId).length;
    for (const a of rep.actors) n += reportsFor(index, "actor", a.id).length;
  }
  return n;
}
