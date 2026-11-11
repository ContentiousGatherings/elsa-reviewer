import { EventStore, TsvParser, releaseFromFileName } from "./tsv.js";
import {
  downloadName,
  indexReports,
  isExcluded,
  makeRecord,
  packForGitHub,
  parseBlocklist,
  reportCount,
  reportFileName,
  reportsFor,
} from "./reports.js";

const FFLATE = "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";
const PAGE_SIZE = 50;
const BASKET_KEY = "elsa-reviewer-basket";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const state = {
  schema: null,
  events: [],
  shown: [],
  page: 0,
  selected: null,
  index: new Map(),
  basket: loadBasket(),
  fileName: "",
  release: null,
  pending: null, // report being written in the dialog
  sending: 0, // records in the last GitHub link
};

// ---------------------------------------------------------------- start

async function init() {
  state.schema = await (await fetch("schema.json")).json();
  $("releases-link").href = state.schema.releases_url;
  $("suggest").href =
    `https://github.com/${state.schema.repo}/issues/new?template=improvement.yml`;
  await loadBlocklist();
  updateBasket();
  wireStart();
  wireBrowse();
  wireDialogs();
}

async function loadBlocklist() {
  try {
    const res = await fetch("blocklist.jsonl", { cache: "no-cache" });
    if (res.ok) state.index = indexReports(parseBlocklist(await res.text()));
  } catch {
    // No list yet (or offline): nothing is hidden.
  }
}

function wireStart() {
  const input = $("file-input");
  input.addEventListener("change", () => {
    if (input.files[0]) openFile(input.files[0]);
  });
  const drop = $("drop");
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    if (e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
  });
  $("open-other").addEventListener("click", () => {
    $("browse").hidden = true;
    $("start").hidden = false;
    $("open-other").hidden = true;
    input.value = "";
  });
}

function setProgress(done, total, text) {
  $("progress").hidden = false;
  $("progress-fill").style.width = `${Math.round((100 * done) / total)}%`;
  $("progress-text").textContent = text;
}

async function openFile(file) {
  $("load-error").hidden = true;
  $("drop").hidden = true;
  try {
    const events = await readExport(file);
    state.events = events;
    state.fileName = file.name.replace(/\.zip$/, "");
    state.release = releaseFromFileName(file.name);
    $("file-label").textContent =
      `${file.name} · ${events.length.toLocaleString()} gatherings`;
    fillFilterOptions();
    $("start").hidden = true;
    $("browse").hidden = false;
    $("open-other").hidden = false;
    updateBasket();
    applyFilters();
  } catch (err) {
    $("load-error").textContent = "Could not open the file: " + err.message;
    $("load-error").hidden = false;
  } finally {
    $("drop").hidden = false;
    $("progress").hidden = true;
  }
}

// Streams the (zipped) TSV through the parser, yielding to the page
// between chunks so the progress bar moves.
async function readExport(file) {
  let store = null;
  const parser = new TsvParser((row) => {
    if (store) store.add(row);
    else store = new EventStore(row);
  });
  const decoder = new TextDecoder();
  const feed = (bytes, final) => {
    parser.push(decoder.decode(bytes, { stream: !final }));
    if (final) parser.end();
  };

  let push = feed;
  if (file.name.endsWith(".zip")) {
    const { Unzip, UnzipInflate } = await import(FFLATE);
    const unzip = new Unzip();
    unzip.register(UnzipInflate);
    let found = false;
    unzip.onfile = (entry) => {
      if (found || !entry.name.endsWith(".tsv")) return;
      found = true;
      entry.ondata = (err, chunk, final) => {
        if (err) throw err;
        feed(chunk, final);
      };
      entry.start();
    };
    push = (bytes, final) => unzip.push(bytes, final);
  }

  const reader = file.stream().getReader();
  let done = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) {
      push(new Uint8Array(0), true);
      break;
    }
    push(value, false);
    done += value.length;
    const rows = store ? store.rows.toLocaleString() : "0";
    setProgress(done, file.size, `Reading… ${rows} rows`);
    await new Promise((r) => setTimeout(r));
  }
  if (!store) throw new Error("the file is empty or not an elsa export.");
  setProgress(1, 1, "Sorting…");
  await new Promise((r) => setTimeout(r));
  return store.finish();
}

// --------------------------------------------------------------- browse

function countBy(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function fillSelect(id, label, entries) {
  $(id).innerHTML =
    `<option value="">All ${esc(label)}</option>` +
    entries
      .map(
        ([v, n]) =>
          `<option value="${esc(v)}">${esc(v)} (${n.toLocaleString()})</option>`,
      )
      .join("");
}

function fillFilterOptions() {
  const ev = state.events;
  fillSelect("f-journal", "newspapers", countBy(ev.flatMap((e) => e.journals)));
  fillSelect("f-type", "types", countBy(ev.flatMap((e) => e.types)));
  fillSelect("f-county", "counties", countBy(ev.map((e) => e.county)));
}

function wireBrowse() {
  let timer;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(applyFilters, 250);
  };
  for (const id of ["f-search", "f-from", "f-to"]) {
    $(id).addEventListener("input", later);
  }
  for (const id of ["f-text", "f-journal", "f-type", "f-county", "f-reported"]) {
    $(id).addEventListener("change", applyFilters);
  }
  $("f-clear").addEventListener("click", () => {
    for (const id of ["f-search", "f-from", "f-to", "f-journal", "f-type", "f-county"]) {
      $(id).value = "";
    }
    $("f-text").checked = false;
    $("f-reported").checked = false;
    applyFilters();
  });
  $("prev").addEventListener("click", () => turnPage(-1));
  $("next").addEventListener("click", () => turnPage(1));
  $("list").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-key]");
    if (li) select(li.dataset.key);
  });
  $("list").addEventListener("keydown", (e) => {
    const li = e.target.closest("li[data-key]");
    if (li && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      select(li.dataset.key);
    }
  });
  $("detail").addEventListener("click", onDetailClick);
}

function applyFilters() {
  const q = $("f-search").value.trim().toLowerCase();
  const inText = $("f-text").checked;
  const journal = $("f-journal").value;
  const type = $("f-type").value;
  const county = $("f-county").value;
  const from = Number($("f-from").value) || null;
  const to = Number($("f-to").value) || null;
  const showReported = $("f-reported").checked;

  state.shown = state.events.filter((ev) => {
    if (journal && !ev.journals.includes(journal)) return false;
    if (type && !ev.types.includes(type)) return false;
    if (county && ev.county !== county) return false;
    if (from && (ev.year === null || ev.year < from)) return false;
    if (to && (ev.year === null || ev.year > to)) return false;
    if (!showReported && isExcluded(state.index, ev)) return false;
    if (q && !ev.haystack.includes(q)) {
      if (!inText) return false;
      return ev.reports.some((r) => r.excerpt.toLowerCase().includes(q));
    }
    return true;
  });
  state.page = 0;
  renderList();
}

function turnPage(step) {
  const last = Math.max(0, Math.ceil(state.shown.length / PAGE_SIZE) - 1);
  state.page = Math.min(last, Math.max(0, state.page + step));
  renderList();
  $("list").scrollIntoView({ block: "start" });
}

function dateText(ev) {
  if (!ev.date) return "Date unknown";
  if (ev.dateEnd && ev.dateEnd !== ev.dateStart) {
    return `${ev.dateStart} – ${ev.dateEnd}`;
  }
  return ev.date;
}

function renderList() {
  const total = state.shown.length;
  const start = state.page * PAGE_SIZE;
  const items = state.shown.slice(start, start + PAGE_SIZE);
  $("list-count").textContent = total
    ? `${total.toLocaleString()} gathering${total === 1 ? "" : "s"}`
    : "No gatherings match these filters.";
  $("page-label").textContent = total
    ? `${start + 1}–${start + items.length}`
    : "";
  $("prev").disabled = state.page === 0;
  $("next").disabled = start + PAGE_SIZE >= total;
  $("list").innerHTML = items
    .map((ev) => {
      const n = reportCount(state.index, ev);
      const flag = isExcluded(state.index, ev)
        ? `<span class="tag">reported: not to be included</span>`
        : n
          ? `<span class="tag">${n} reported problem${n > 1 ? "s" : ""}</span>`
          : "";
      const reports = ev.reports.length;
      return `<li tabindex="0" data-key="${esc(ev.key)}" class="${
        ev.key === state.selected ? "selected" : ""
      }">
        <div><span class="when">${esc(dateText(ev))}</span> · ${esc(
          ev.placeShown || "Place unknown",
        )}${flag}</div>
        <div class="sub">${esc(ev.types.join(", ") || "Type unknown")} · ${reports} newspaper report${
          reports > 1 ? "s" : ""
        }</div>
      </li>`;
    })
    .join("");
}

function select(key) {
  state.selected = key;
  renderList();
  renderDetail();
  $("browse").classList.add("showing-detail");
  $("detail").scrollTop = 0;
  if (window.matchMedia("(max-width: 60rem)").matches) window.scrollTo(0, 0);
}

function current() {
  return state.events.find((e) => e.key === state.selected);
}

function flags(target, id) {
  return reportsFor(state.index, target, id)
    .map((r) => {
      const reason = r.reason ? ` (${state.schema.reasons[r.reason] || r.reason})` : "";
      const comment = r.comment ? `: “${esc(r.comment)}”` : "";
      return `<div class="flagged">Reported: ${esc(
        state.schema.problems[r.problem] || r.problem,
      )}${esc(reason)}${comment}</div>`;
    })
    .join("");
}

function reportButton(label, target, id, extra = {}) {
  const attrs = Object.entries({ target, id, ...extra })
    .map(([k, v]) => `data-${k}="${esc(v)}"`)
    .join(" ");
  return `<button class="secondary report-btn" ${attrs}>${esc(label)}</button>`;
}

function readBy(label, value, excerpt) {
  if (!value) return "";
  const how = excerpt
    ? `<details><summary>where it says so</summary><div class="excerpt">${esc(excerpt)}</div></details>`
    : "";
  return `<dt>${esc(label)}</dt><dd>${esc(value)}${how}</dd>`;
}

function renderDetail() {
  const ev = current();
  if (!ev) return;
  const map =
    ev.lat != null && ev.lon != null
      ? ` · <a target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${ev.lat}&mlon=${ev.lon}#map=11/${ev.lat}/${ev.lon}">map</a>`
      : "";
  const head = ev.aeId
    ? reportButton("Report a problem with this gathering", "authoritative_event", ev.aeId, { ae: ev.aeId })
    : `<span class="muted">Not combined into a gathering yet</span>`;
  const reports = ev.reports
    .map((r) => {
      const actors = r.actors.length
        ? `<ul class="actors">${r.actors
            .map(
              (a) => `<li><span>${esc(a.name)}${
                a.authName && a.authName !== a.name
                  ? ` <span class="muted">(${esc(a.authName)})</span>`
                  : ""
              }</span> ${reportButton("Report", "actor", a.id, {
                ae: ev.aeId ?? "",
                event: r.eventId,
                name: a.name,
              })}${flags("actor", a.id)}</li>`,
            )
            .join("")}</ul>`
        : `<p class="muted">No actors named.</p>`;
      return `<section class="report">
        <h4>${esc(r.journal || "Unknown newspaper")} · ${esc(r.articleDate)}</h4>
        ${flags("event", r.eventId)}
        <div class="excerpt">${esc(r.excerpt)}</div>
        <dl class="facts">
          ${readBy("Type", r.type, r.typeExcerpt)}
          ${readBy("When", [r.time, r.timeNormalized && `(${r.timeNormalized})`].filter(Boolean).join(" "), r.timeExcerpt)}
          ${readBy("Where", [r.location, r.locationCountry && `(${r.locationCountry})`].filter(Boolean).join(" "), r.locationExcerpt)}
        </dl>
        <strong>Actors</strong>
        ${actors}
        ${reportButton("Report a problem with this newspaper report", "event", r.eventId, { ae: ev.aeId ?? "", event: r.eventId })}
        <p class="muted small">Newspaper report ${r.eventId} · article ${esc(r.articleId)}</p>
      </section>`;
    })
    .join("");
  $("detail").innerHTML = `
    <button class="secondary back" id="back">← Back to the list</button>
    <header><h3>${esc(dateText(ev))} · ${esc(ev.placeShown || "Place unknown")}</h3></header>
    ${flags("authoritative_event", ev.aeId)}
    <dl class="facts">
      ${readBy("County", ev.county)}
      ${readBy("Country", ev.country)}
      ${readBy("Type", ev.types.join(", "))}
      <dt>Gathering</dt><dd>${ev.aeId ? `no. ${ev.aeId}` : "—"}${map}</dd>
    </dl>
    ${head}
    <h3 style="margin-top:1.2rem">Newspaper reports (${ev.reports.length})</h3>
    ${reports}`;
}

function onDetailClick(e) {
  if (e.target.id === "back") {
    $("browse").classList.remove("showing-detail");
    return;
  }
  const btn = e.target.closest(".report-btn");
  if (!btn) return;
  const d = btn.dataset;
  openReport({
    target: d.target,
    id: Number(d.id),
    authoritative_event_id: d.ae ? Number(d.ae) : null,
    event_id: d.event ? Number(d.event) : null,
    name: d.name,
  });
}

// -------------------------------------------------------------- reports

function subjectText(p) {
  if (p.target === "actor") return `Actor “${p.name}” in newspaper report ${p.event_id}`;
  if (p.target === "event") return `Newspaper report ${p.id}`;
  return `Gathering no. ${p.id}`;
}

function openReport(pending) {
  state.pending = pending;
  const spec = state.schema.targets[pending.target];
  $("report-title").textContent = `What is wrong with this ${spec.label}?`;
  $("report-subject").textContent = subjectText(pending);
  $("report-problems").innerHTML = spec.problems
    .map(
      (p, i) => `<label class="check"><input type="radio" name="problem" value="${p}" ${
        i === 0 ? "checked" : ""
      }> ${esc(state.schema.problems[p])}</label>`,
    )
    .join("");
  $("report-reason").innerHTML =
    `<option value="">Choose a reason (optional)</option>` +
    Object.entries(state.schema.reasons)
      .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`)
      .join("");
  $("report-comment").value = "";
  syncReason();
  $("report-dialog").showModal();
}

function syncReason() {
  const problem = $("report-form").problem?.value;
  $("report-reason-wrap").hidden = problem !== "exclude";
}

function wireDialogs() {
  $("report-problems").addEventListener("change", syncReason);
  $("report-dialog").addEventListener("close", () => {
    if ($("report-dialog").returnValue !== "add" || !state.pending) return;
    const p = state.pending;
    const problem = $("report-form").problem.value;
    const record = makeRecord(state.schema, {
      ...p,
      problem,
      reason: problem === "exclude" ? $("report-reason").value : "",
      comment: $("report-comment").value,
      release: state.release,
      file: state.fileName,
    });
    state.basket.push({ record, subject: subjectText(p) });
    state.pending = null;
    saveBasket();
    updateBasket();
  });

  $("open-basket").addEventListener("click", () => {
    renderBasket();
    $("sent-confirm").hidden = true;
    $("basket-dialog").showModal();
  });
  $("basket-list").addEventListener("click", (e) => {
    const i = e.target.dataset.remove;
    if (i === undefined) return;
    state.basket.splice(Number(i), 1);
    saveBasket();
    updateBasket();
    renderBasket();
  });
  $("send").addEventListener("click", () => {
    const records = state.basket.map((b) => b.record);
    const { url, count } = packForGitHub(
      state.schema.repo,
      records,
      reportFileName(),
    );
    if (!url) return;
    state.sending = count;
    window.open(url, "_blank", "noopener");
    const rest = state.basket.length - count;
    askToRemove(
      "Did GitHub show <em>Create pull request</em> and did you press it?" +
        (rest ? ` (${rest} more report${rest > 1 ? "s" : ""} will need another send.)` : ""),
    );
  });
  $("download").addEventListener("click", () => {
    const records = state.basket.map((b) => b.record);
    const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    link.download = downloadName();
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    state.sending = records.length;
    askToRemove(
      `Saved as <em>${esc(link.download)}</em> in your downloads. ` +
        "Attach it to an e-mail to the project. Remove these reports from the list?",
    );
  });
  function askToRemove(question) {
    $("sent-question").innerHTML = question;
    $("sent-confirm").hidden = false;
  }
  $("sent-no").addEventListener("click", () => {
    $("sent-confirm").hidden = true;
  });
  $("sent-yes").addEventListener("click", () => {
    state.basket.splice(0, state.sending);
    state.sending = 0;
    saveBasket();
    updateBasket();
    renderBasket();
    $("sent-confirm").hidden = true;
  });
}

function renderBasket() {
  const items = state.basket;
  $("basket-list").innerHTML = items.length
    ? items
        .map(({ record: r, subject }, i) => {
          const reason = r.reason ? ` (${state.schema.reasons[r.reason]})` : "";
          const comment = r.comment ? ` — “${esc(r.comment)}”` : "";
          return `<li>${esc(subject)}: ${esc(state.schema.problems[r.problem])}${esc(
            reason,
          )}${comment} <button type="button" class="link" data-remove="${i}">remove</button></li>`;
        })
        .join("")
    : `<li class="muted">No reports yet.</li>`;
  $("send").disabled = !items.length;
  $("download").disabled = !items.length;
  $("send-help").hidden = !items.length;
  $("download-help").hidden = !items.length;
}

function loadBasket() {
  try {
    return JSON.parse(localStorage.getItem(BASKET_KEY)) || [];
  } catch {
    return [];
  }
}

function saveBasket() {
  try {
    localStorage.setItem(BASKET_KEY, JSON.stringify(state.basket));
  } catch {
    // Private windows may refuse storage; the list still works until reload.
  }
}

function updateBasket() {
  $("basket-count").textContent = state.basket.length;
  $("open-basket").hidden = !state.basket.length && !state.events.length;
}

init();
