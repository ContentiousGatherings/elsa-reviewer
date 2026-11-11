// Streaming reader for elsa's TSV exports.
//
// Text fields are double-quoted and never contain a quote (the exporter
// turns " into a backtick), so a quote always opens or closes a field and
// line breaks inside quotes belong to the field.

export class TsvParser {
  constructor(onRow) {
    this.onRow = onRow;
    this.field = "";
    this.row = [];
    this.inQuotes = false;
  }

  push(text) {
    const n = text.length;
    let i = 0;
    while (i < n) {
      if (this.inQuotes) {
        const j = text.indexOf('"', i);
        if (j < 0) {
          this.field += text.slice(i);
          return;
        }
        this.field += text.slice(i, j);
        this.inQuotes = false;
        i = j + 1;
        continue;
      }
      const c = text[i];
      if (c === '"') {
        this.inQuotes = true;
        i++;
      } else if (c === "\t") {
        this.endField();
        i++;
      } else if (c === "\n") {
        this.endField();
        this.endRow();
        i++;
      } else if (c === "\r") {
        i++;
      } else {
        let j = i + 1;
        while (j < n && !'\t\n"\r'.includes(text[j])) j++;
        this.field += text.slice(i, j);
        i = j;
      }
    }
  }

  end() {
    if (this.field !== "" || this.row.length) {
      this.endField();
      this.endRow();
    }
  }

  endField() {
    this.row.push(this.field);
    this.field = "";
  }

  endRow() {
    const row = this.row;
    this.row = [];
    if (row.length > 1 || row[0] !== "") this.onRow(row);
  }
}

const int = (v) => (v === "" ? null : Math.trunc(Number(v)));
const num = (v) => (v === "" ? null : Number(v));

// Groups export rows (gathering x newspaper report x actor) into
// gatherings, each with its reports and each report with its actors.
// Reports that never became a gathering (internal-meetings) stand alone.
export class EventStore {
  constructor(header) {
    this.col = Object.fromEntries(header.map((name, i) => [name, i]));
    for (const name of ["event_id", "authoritative_event_id"]) {
      if (!(name in this.col)) {
        throw new Error("This is not an elsa export file (no " + name + ").");
      }
    }
    this.byKey = new Map();
    this.rows = 0;
  }

  get(row, name) {
    const i = this.col[name];
    return i === undefined ? "" : row[i] ?? "";
  }

  add(row) {
    const g = (name) => this.get(row, name);
    this.rows++;
    const aeId = int(g("authoritative_event_id"));
    const eventId = int(g("event_id"));
    const key = aeId !== null ? "g" + aeId : "r" + eventId;
    let ev = this.byKey.get(key);
    if (!ev) {
      ev = {
        key,
        aeId,
        dateStart: g("authoritative_date_start"),
        dateEnd: g("authoritative_date_end"),
        place: g("authoritative_location"),
        county: g("authoritative_county"),
        country: g("authoritative_country"),
        lat: num(g("authoritative_latitude")),
        lon: num(g("authoritative_longitude")),
        reports: new Map(),
      };
      this.byKey.set(key, ev);
    }
    let rep = ev.reports.get(eventId);
    if (!rep) {
      rep = {
        eventId,
        articleId: g("article_id"),
        articleDate: g("article_date").slice(0, 10),
        journal: g("article_journal"),
        excerpt: g("event_excerpt"),
        reasoning: g("event_reasoning"),
        type: g("type"),
        typeExcerpt: g("type_excerpt"),
        time: g("time"),
        timeExcerpt: g("time_excerpt"),
        timeNormalized: g("time_normalized").slice(0, 10),
        location: g("location"),
        locationExcerpt: g("location_excerpt"),
        locationCountry: g("location_country"),
        actors: [],
      };
      ev.reports.set(eventId, rep);
    }
    const actorId = int(g("actor_id"));
    if (actorId !== null) {
      const authId = int(g("authoritative_actor_id"));
      if (!rep.actors.some((a) => a.id === actorId && a.authId === authId)) {
        rep.actors.push({
          id: actorId,
          name: g("actor"),
          authName: g("authoritative_actor"),
          authId,
          excerpt: g("actor_excerpt"),
        });
      }
    }
  }

  // Plain arrays, sorted by date, with the fields the filters use.
  finish() {
    const events = [];
    for (const ev of this.byKey.values()) {
      const reports = [...ev.reports.values()];
      const date =
        ev.dateStart || reports.find((r) => r.timeNormalized)?.timeNormalized;
      const types = [...new Set(reports.map((r) => r.type).filter(Boolean))];
      const journals = [
        ...new Set(reports.map((r) => r.journal).filter(Boolean)),
      ];
      const actors = new Set();
      for (const r of reports) {
        for (const a of r.actors) actors.add(a.authName || a.name);
      }
      const place = ev.place || reports.find((r) => r.location)?.location || "";
      events.push({
        ...ev,
        reports,
        date: date || "",
        year: date ? Number(date.slice(0, 4)) : null,
        placeShown: place,
        types,
        journals,
        actorNames: [...actors].filter(Boolean),
        haystack: [place, ev.county, ...types, ...journals, ...actors]
          .join(" ")
          .toLowerCase(),
      });
    }
    events.sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
    return events;
  }
}

// "elsa_export_2026-11-11_w_prerelease.tsv.zip" -> "data-export-2026-11-11"
export function releaseFromFileName(name) {
  const m = /elsa_export_(\d{4}-\d{2}-\d{2})/.exec(name || "");
  return m ? "data-export-" + m[1] : null;
}
