/* Moodmate — a local-only mood journal.
   Entries never leave the device: everything lives in localStorage, which is
   also why there is no account, no sync and no backend to pay for. */

const STORE = "moodmate.v1";
const ASSETS = "assets/";
const SCHEMA = 2;              // 1 = mood + note, 2 = adds activity tags
const MIN_SAMPLE = 5;          // fewer entries than this and a stat is noise
const QUICK_TAGS = 10;         // tags shown before "More"

const TAG_GROUPS = [
  ["life", "groupLife"], ["social", "groupSocial"],
  ["health", "groupHealth"], ["leisure", "groupLeisure"],
];

/* Seeded on first run. Emoji rather than drawn icons on purpose: tags need
   ~20 icons now and more with every user request, and emoji cost nothing,
   scale to any size, and skip the art pipeline entirely. */
const DEFAULT_TAGS = [
  ["work", "Work", "💼", "life"],
  ["study", "Study", "📚", "life"],
  ["chores", "Chores", "🧹", "life"],
  ["errands", "Errands", "📮", "life"],
  ["shopping", "Shopping", "🛍️", "life"],
  ["friends", "Friends", "🫂", "social"],
  ["family", "Family", "🏡", "social"],
  ["partner", "Partner", "💕", "social"],
  ["party", "Party", "🎉", "social"],
  ["alone", "Alone time", "🧸", "social"],
  ["exercise", "Exercise", "🏃", "health"],
  ["walk", "Walk", "🚶", "health"],
  ["sleep_good", "Slept well", "😴", "health"],
  ["sleep_bad", "Slept badly", "🥱", "health"],
  ["unwell", "Unwell", "🤒", "health"],
  ["reading", "Reading", "📖", "leisure"],
  ["gaming", "Gaming", "🎮", "leisure"],
  ["watching", "Film / TV", "🎬", "leisure"],
  ["music", "Music", "🎵", "leisure"],
  ["cooking", "Cooking", "🍳", "leisure"],
  ["outdoors", "Outdoors", "🌳", "leisure"],
];

const state = {
  // "en" | "zh". Chinese is the default for a first run; a stored preference
  // always wins, so anyone who has picked EN keeps it.
  lang: "zh",
  character: "girl",                             // which body is worn
  entries: {},                                   // "YYYY-MM-DD" -> {mood, note, tags}
  tags: [],                                      // {id, label, icon, group, order, archived}
  outfit: { hat: null, top: null, bottom: null },
  manifest: null,
  entryDate: null,                               // which day the entry screen edits
  draftMood: null,
  draftTags: null,
  viewMonth: null,                               // Date, first of the shown month
  selectedDay: null,
  editing: null,                                 // date key currently being edited
  editMood: null,
  editTags: null,
  confirmDelete: null,                           // date key awaiting delete confirmation
  tagsExpanded: false,
  tagFilter: null,                               // tag id the calendar is filtered to
  returnTo: "today",                             // screen the manage view came from
  renaming: null,                                // tag id being renamed
  confirmTagDelete: null,
};

/* ── storage ─────────────────────────────────────────────────── */

function seedTags() {
  return DEFAULT_TAGS.map(([id, label, icon, group], i) =>
    ({ id: "t_" + id, label, icon, group, order: i, archived: false }));
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || "{}");
    state.entries = raw.entries || {};
    // First run starts dressed — an undressed character reads as unfinished.
    // Only absent storage gets the default; someone who took the hoodie off
    // has made a choice, and reload shouldn't undo it.
    state.outfit = raw.outfit
      ? Object.assign({ hat: null, top: null, bottom: null }, raw.outfit)
      : { hat: null, top: "hoodie", bottom: null };
    state.tags = Array.isArray(raw.tags) && raw.tags.length ? raw.tags : seedTags();
    if (raw.lang === "en" || raw.lang === "zh") state.lang = raw.lang;
    if (raw.character) state.character = raw.character;

    // Migration to schema 2. Entries written before tags existed simply have
    // none; give them an empty array so nothing downstream has to special-case
    // a missing field. Runs once and is invisible.
    if (!raw.version || raw.version < 2) {
      for (const e of Object.values(state.entries)) {
        if (!Array.isArray(e.tags)) e.tags = [];
      }
      save();
    }
  } catch {
    /* Corrupt or unreadable storage shouldn't brick the app; start fresh
       rather than throwing before the first render. */
    state.tags = seedTags();
    state.outfit = { hat: null, top: "hoodie", bottom: null };
  }
}

function save() {
  localStorage.setItem(STORE, JSON.stringify({
    version: SCHEMA, lang: state.lang, character: state.character, entries: state.entries,
    tags: state.tags, outfit: state.outfit,
  }));
}

/* ── language ────────────────────────────────────────────────── */

const t = (k) => (STRINGS[k] ? STRINGS[k][state.lang] || STRINGS[k].en : k);
const locale = () => LOCALE[state.lang];

// Manifest entries carry both names; fall back to English if a translation
// is missing so a new item is untranslated rather than blank.
const nameOf = (o) => (state.lang === "zh" && o.label_zh) ? o.label_zh : o.label;

// Built-in tags translate by id. Once renamed, whatever the user typed wins —
// translating their own words back into a stock label would be wrong.
function tagName(tag) {
  if (state.lang === "zh" && !tag.renamed && TAG_STRINGS[tag.id]) return TAG_STRINGS[tag.id];
  return tag.label;
}

function setLang(l) {
  state.lang = l;
  save();
  document.documentElement.lang = l === "zh" ? "zh-Hant-HK" : "en";
  applyStaticStrings();
  renderToday();
  renderHistory();
  renderCloset();
  renderTags();
  for (const b of document.querySelectorAll("#lang-toggle button")) {
    b.classList.toggle("on", b.dataset.lang === l);
  }
}

// Static markup carries data-i18n / data-i18n-ph keys so the HTML stays
// readable and there's no separate list of element ids to keep in sync.
function applyStaticStrings() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll("[data-i18n-ph]")) {
    el.placeholder = t(el.dataset.i18nPh);
  }
  document.title = state.lang === "zh" ? "心情夥伴" : "Moodmate";
}

/* ── tags ────────────────────────────────────────────────────── */

const tagById = (id) => state.tags.find((t) => t.id === id);
const liveTags = () => state.tags.filter((t) => !t.archived);
const MOOD_SCORE = { awful: 1, bad: 2, meh: 3, good: 4, rad: 5 };

function tagUseCount(id) {
  let n = 0;
  for (const e of Object.values(state.entries)) if ((e.tags || []).includes(id)) n++;
  return n;
}

/* Most-used first so a regular gym-goer taps one chip, with the stored order
   as a stable tiebreak. */
function tagsByUse(list) {
  return list.slice().sort((a, b) =>
    tagUseCount(b.id) - tagUseCount(a.id) || a.order - b.order);
}

function tagChip(t, selected, onToggle) {
  const b = document.createElement("button");
  b.className = "tag" + (selected ? " on" : "");
  b.setAttribute("aria-pressed", String(selected));
  b.innerHTML = `<span class="ic">${t.icon}</span>`;
  const label = document.createElement("span");
  label.textContent = tagName(t);
  b.appendChild(label);
  if (onToggle) b.onclick = () => onToggle(t.id);
  return b;
}

/* One picker, used on the entry screen and in the history editor. */
function buildTagPicker(selected, onToggle) {
  const wrap = document.createElement("div");
  wrap.className = "tagpicker";

  if (!state.tagsExpanded) {
    const row = document.createElement("div");
    row.className = "tagrow";
    const quick = tagsByUse(liveTags()).slice(0, QUICK_TAGS).map((t) => t.id);
    // Selected tags always render, even if they're not in the quick list —
    // otherwise something you just picked can scroll out of existence.
    const shown = liveTags().filter((t) => quick.includes(t.id) || selected.includes(t.id));
    for (const t of tagsByUse(shown)) row.appendChild(tagChip(t, selected.includes(t.id), onToggle));
    wrap.appendChild(row);
  } else {
    for (const [g, title] of TAG_GROUPS) {
      const inGroup = tagsByUse(liveTags().filter((t) => t.group === g));
      if (!inGroup.length) continue;
      const h = document.createElement("h3");
      h.className = "taggroup";
      h.textContent = t(title);
      const row = document.createElement("div");
      row.className = "tagrow";
      for (const t of inGroup) row.appendChild(tagChip(t, selected.includes(t.id), onToggle));
      wrap.append(h, row);
    }
  }

  const foot = document.createElement("div");
  foot.className = "tagfoot";
  const more = document.createElement("button");
  more.className = "linkish";
  more.textContent = t(state.tagsExpanded ? "fewerTags" : "moreTags");
  more.onclick = () => { state.tagsExpanded = !state.tagsExpanded; rerender(); };
  const manage = document.createElement("button");
  manage.className = "linkish";
  manage.textContent = t("manageTags");
  manage.onclick = () => {
    state.returnTo = document.querySelector(".screen:not([hidden])").dataset.screen;
    goto("tags");
  };
  foot.append(more, manage);
  wrap.appendChild(foot);
  return wrap;
}

function toggleIn(list, id) {
  const i = list.indexOf(id);
  if (i === -1) list.push(id); else list.splice(i, 1);
  return list;
}

/* ── dates ───────────────────────────────────────────────────── */

// Local date key. Deliberately not toISOString(), which converts to UTC and
// would file a late-evening entry under tomorrow for anyone east of GMT.
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayKey = () => key(new Date());

function shiftDays(k, n) {
  const [y, m, d] = k.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return key(dt);
}

function streak() {
  let n = 0;
  let k = todayKey();
  // Today not being logged yet shouldn't zero a run, so start from yesterday
  // when today is empty.
  if (!state.entries[k]) k = shiftDays(k, -1);
  while (state.entries[k]) { n++; k = shiftDays(k, -1); }
  return n;
}

/* ── character rendering ─────────────────────────────────────── */

const charById = (id) => state.manifest.characters.find((c) => c.id === id)
                      || state.manifest.characters[0];

// Every layer is per character: the two bodies share a canvas and a hip line,
// but not a hairline, so an item only draws when art exists for that character.
function layersFor(mood, outfit, character) {
  const m = state.manifest;
  const ch = character || state.character;
  const out = [{ src: charById(ch).base, z: 0 }];
  const push = (id, slot) => {
    const it = m.items.find((i) => i.id === id);
    if (it && it.layer[ch]) out.push({ src: it.layer[ch], z: m.slots[slot] });
  };
  if (outfit.bottom) push(outfit.bottom, "bottom");
  if (outfit.top) push(outfit.top, "top");
  const mo = m.moods.find((x) => x.key === mood);
  if (mo && mo.layer && mo.layer[ch]) out.push({ src: mo.layer[ch], z: m.slots.face });
  if (outfit.hat) push(outfit.hat, "hat");
  return out.sort((a, b) => a.z - b.z);
}

function renderChar(el, mood, outfit, character) {
  el.innerHTML = "";
  for (const l of layersFor(mood, outfit, character)) {
    const img = new Image();
    img.src = ASSETS + l.src;
    img.alt = "";
    el.appendChild(img);
  }
}

// `tight` crops to the face alone. At calendar size a full head crop spends
// most of its pixels on hair and shoulders, leaving the expression — the only
// thing that distinguishes one day from another — a few pixels across.
function headChip(mood, tight, character) {
  const wrap = document.createElement("div");
  wrap.className = "head" + (tight ? " tight" : "");
  for (const l of layersFor(mood, { hat: null, top: null, bottom: null }, character)) {
    const img = new Image();
    img.src = ASSETS + l.src;
    img.alt = "";
    wrap.appendChild(img);
  }
  return wrap;
}

/* ── today ───────────────────────────────────────────────────── */

function renderToday() {
  const day = state.entryDate || todayKey();
  const isToday = day === todayKey();
  const entry = state.entries[day];
  if (state.draftMood === null) state.draftMood = entry ? entry.mood : "meh";
  if (state.draftTags === null) state.draftTags = entry ? (entry.tags || []).slice() : [];

  document.getElementById("entry-title").textContent = isToday ? t("today") : prettyDate(day);
  const dateInput = document.getElementById("entry-date");
  dateInput.value = day;
  dateInput.max = todayKey();            // no logging moods you haven't had yet
  document.getElementById("jump-today").hidden = isToday;
  document.getElementById("streak-count").textContent = streak();

  const picker = document.getElementById("picker");
  picker.innerHTML = "";
  for (const m of state.manifest.moods) {
    const b = document.createElement("button");
    b.className = "mood";
    b.style.setProperty("--mood", m.color);
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(m.key === state.draftMood));
    b.appendChild(headChip(m.key));
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = nameOf(m);
    b.appendChild(label);
    b.onclick = () => { state.draftMood = m.key; renderToday(); };
    picker.appendChild(b);
  }

  renderChar(document.getElementById("char"), state.draftMood, state.outfit);

  const tags = document.getElementById("tags-today");
  tags.innerHTML = "";
  const picked = buildTagPicker(state.draftTags, (id) => {
    toggleIn(state.draftTags, id);
    renderToday();
  });
  // Selected chips take the colour of the mood being logged, so the whole
  // entry reads as one thing rather than two unrelated colour systems.
  const cur = state.manifest.moods.find((m) => m.key === state.draftMood);
  if (cur) picked.style.setProperty("--mood", cur.color);
  tags.appendChild(picked);

  const note = document.getElementById("note");
  if (document.activeElement !== note) note.value = entry ? entry.note || "" : "";
  document.getElementById("save").textContent =
    t(entry ? "updateEntry" : (isToday ? "saveToday" : "saveEntry"));

  const asking = !!entry && state.confirmDelete === day;
  document.getElementById("delete-today").hidden = !entry || asking;
  document.getElementById("confirm-delete").hidden = !asking;
}

function setEntryDate(k) {
  state.entryDate = k;
  state.draftMood = null;                // let the chosen day's own mood and
  state.draftTags = null;                // tags load
  document.getElementById("note").blur();
  renderToday();
}

function deleteToday() {
  const k = state.entryDate || todayKey();
  if (!state.entries[k]) return;
  delete state.entries[k];
  save();
  state.draftMood = null;
  state.draftTags = null;
  state.confirmDelete = null;
  document.getElementById("note").value = "";
  renderToday();
  renderHistory();
  renderCloset();
}

function saveToday() {
  const note = document.getElementById("note").value.trim();
  const day = state.entryDate || todayKey();
  state.entries[day] = {
    mood: state.draftMood, note, tags: (state.draftTags || []).slice(),
    // Snapshot, not a reference: changing clothes tomorrow must not restyle
    // what you wore today. This is what makes the history a record.
    outfit: Object.assign({}, state.outfit),
    character: state.character,
  };
  save();
  const hint = document.getElementById("saved-hint");
  hint.hidden = false;
  setTimeout(() => { hint.hidden = true; }, 1600);
  renderToday();
  renderCloset();
}

/* ── history ─────────────────────────────────────────────────── */

function renderHistory() {
  if (!state.viewMonth) {
    const n = new Date();
    state.viewMonth = new Date(n.getFullYear(), n.getMonth(), 1);
  }
  const first = state.viewMonth;
  document.getElementById("month-label").textContent =
    first.toLocaleDateString(locale(), { month: "long", year: "numeric" });

  const wd = document.getElementById("weekdays");
  wd.innerHTML = "";
  {
    for (const d of WEEKDAYS[state.lang]) {
      const s = document.createElement("span");
      s.textContent = d;
      wd.appendChild(s);
    }
  }

  // Filter row: tags actually used in the visible month, so it stays short.
  const monthPrefix = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}`;
  const used = new Set();
  for (const [k, e] of Object.entries(state.entries)) {
    if (k.startsWith(monthPrefix)) for (const t of e.tags || []) used.add(t);
  }
  const filterRow = document.getElementById("tag-filter");
  filterRow.innerHTML = "";
  filterRow.hidden = used.size === 0;
  if (used.size) {
    const all = document.createElement("button");
    all.className = "tag" + (state.tagFilter ? "" : " on");
    all.textContent = t("all");
    all.onclick = () => { state.tagFilter = null; renderHistory(); };
    filterRow.appendChild(all);
    for (const t of tagsByUse([...used].map(tagById).filter(Boolean))) {
      filterRow.appendChild(tagChip(t, state.tagFilter === t.id, (id) => {
        state.tagFilter = state.tagFilter === id ? null : id;
        renderHistory();
      }));
    }
  }

  const cal = document.getElementById("calendar");
  cal.innerHTML = "";
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  for (let i = 0; i < first.getDay(); i++) {
    const b = document.createElement("div");
    b.className = "day blank";
    cal.appendChild(b);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(first.getFullYear(), first.getMonth(), d);
    const k = key(dt);
    const entry = state.entries[k];
    const cell = document.createElement("button");
    cell.className = "day" + (entry ? " has-entry" : "") + (k === todayKey() ? " today" : "");
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = d;
    cell.appendChild(num);
    if (entry) {
      const mood = state.manifest.moods.find((x) => x.key === entry.mood);
      if (mood) cell.style.setProperty("--mood", mood.color);
      if (state.tagFilter && !(entry.tags || []).includes(state.tagFilter)) {
        cell.classList.add("dim");
      }
      cell.appendChild(headChip(entry.mood, true, entry.character));
      cell.onclick = () => { state.selectedDay = k; state.editing = null; renderHistory(); };
    } else if (k <= todayKey()) {
      // Empty past day: jump to the entry screen already set to that date, so
      // backfilling a missed day is one tap rather than a hunt in the picker.
      cell.classList.add("addable");
      cell.onclick = () => { setEntryDate(k); goto("today"); };
    }
    cal.appendChild(cell);
  }

  renderDetail();

  const total = Object.keys(state.entries).length;
  const monthKeys = Object.keys(state.entries).filter((k) => k.startsWith(monthPrefix));
  const avg = monthKeys.length
    ? (monthKeys.reduce((s, k) => s + (MOOD_SCORE[state.entries[k].mood] || 3), 0) / monthKeys.length).toFixed(1)
    : "—";
  document.getElementById("stats").innerHTML =
    `<div class="stat"><b>${total}</b><span>${t("entries")}</span></div>
     <div class="stat"><b>${streak()}</b><span>${t("dayStreak")}</span></div>
     <div class="stat"><b>${avg}</b><span>${t("avgMonth")}</span></div>`;

  renderTagStats(monthPrefix);
}

/* Two stats, both guarded by sample size. A mood comparison drawn from two
   entries is noise dressed up as insight, and people take these seriously. */
function renderTagStats(monthPrefix) {
  const box = document.getElementById("tag-stats");
  box.innerHTML = "";
  const all = Object.values(state.entries);
  if (!all.length) { box.hidden = true; return; }
  box.hidden = false;

  const h = document.createElement("h2");
  h.textContent = t("activities");
  box.appendChild(h);

  // Mood with vs without, across all history for the largest sample.
  const rows = [];
  for (const t of state.tags) {
    const withT = all.filter((e) => (e.tags || []).includes(t.id));
    const without = all.filter((e) => !(e.tags || []).includes(t.id));
    if (withT.length < MIN_SAMPLE || without.length < MIN_SAMPLE) continue;
    const mean = (list) => list.reduce((s, e) => s + (MOOD_SCORE[e.mood] || 3), 0) / list.length;
    const a = mean(withT), b = mean(without);
    rows.push({ t, a, b, delta: a - b, n: withT.length });
  }
  rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  if (rows.length) {
    const list = document.createElement("div");
    list.className = "taglist";
    for (const r of rows.slice(0, 3)) {
      const line = document.createElement("div");
      line.className = "tagstat";
      const sign = r.delta >= 0 ? "+" : "−";
      line.innerHTML =
        `<span class="ic">${r.t.icon}</span>
         <span class="nm">${r.t.label}</span>
         <b class="${r.delta >= 0 ? "up" : "down"}">${sign}${Math.abs(r.delta).toFixed(1)}</b>
         <span class="sub">${r.a.toFixed(1)} ${t("vs")} ${r.b.toFixed(1)} · ${r.n} ${t("entries")}</span>`;
      list.appendChild(line);
    }
    box.appendChild(list);
  } else {
    const p = document.createElement("p");
    p.className = "muted-note";
    p.textContent = t("needMore");
    box.appendChild(p);
  }

  // Frequency for the visible month.
  const counts = new Map();
  for (const [k, e] of Object.entries(state.entries)) {
    if (!k.startsWith(monthPrefix)) continue;
    for (const id of e.tags || []) counts.set(id, (counts.get(id) || 0) + 1);
  }
  if (counts.size) {
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const max = top[0][1];
    const list = document.createElement("div");
    list.className = "taglist";
    const sub = document.createElement("p");
    sub.className = "muted-note";
    sub.textContent = t("mostLogged");
    box.appendChild(sub);
    for (const [id, n] of top) {
      const t = tagById(id);
      if (!t) continue;
      const line = document.createElement("div");
      line.className = "tagbar";
      line.innerHTML =
        `<span class="ic">${t.icon}</span><span class="nm">${t.label}</span>
         <span class="bar"><i style="width:${Math.round(n / max * 100)}%"></i></span>
         <b>${n}</b>`;
      list.appendChild(line);
    }
    box.appendChild(list);
  }
}

/* ── manage tags ─────────────────────────────────────────────── */

function renderTags() {
  const list = document.getElementById("tag-manage");
  list.innerHTML = "";

  for (const [g, title] of TAG_GROUPS) {
    const inGroup = state.tags.filter((x) => x.group === g).sort((a, b) => a.order - b.order);
    if (!inGroup.length) continue;
    const h = document.createElement("h2");
    h.textContent = t(title);
    list.appendChild(h);

    for (const tg of inGroup) {
      const row = document.createElement("div");
      row.className = "manage-row" + (tg.archived ? " archived" : "");

      if (state.renaming === tg.id) {
        const ic = document.createElement("input");
        ic.className = "icon-input";
        ic.value = tg.icon;
        ic.maxLength = 4;
        const nm = document.createElement("input");
        nm.className = "name-input";
        nm.value = tagName(tg);
        const ok = document.createElement("button");
        ok.className = "ghost small";
        ok.textContent = t("saveChanges");
        ok.onclick = () => {
          tg.icon = ic.value.trim() || tg.icon;
          const typed = nm.value.trim();
          if (typed && typed !== tagName(tg)) { tg.label = typed; tg.renamed = true; }
          state.renaming = null;
          save(); renderTags();
        };
        row.append(ic, nm, ok);
        list.appendChild(row);
        continue;
      }

      row.innerHTML = `<span class="ic">${tg.icon}</span><span class="nm">${tagName(tg)}</span>`;
      const used = tagUseCount(tg.id);
      const count = document.createElement("span");
      count.className = "sub";
      count.textContent = used ? `${used}×` : "";
      const rename = document.createElement("button");
      rename.className = "ghost small";
      rename.textContent = t("edit");
      rename.onclick = () => { state.renaming = tg.id; renderTags(); };
      const arch = document.createElement("button");
      arch.className = "ghost small";
      arch.textContent = t(tg.archived ? "restore" : "archive");
      arch.onclick = () => { tg.archived = !tg.archived; save(); renderTags(); };
      const del = document.createElement("button");
      del.className = "ghost small danger";
      del.textContent = t("del");
      del.onclick = () => { state.confirmTagDelete = tg.id; renderTags(); };
      row.append(count, rename, arch, del);
      list.appendChild(row);

      if (state.confirmTagDelete === tg.id) {
        // Archiving is the safe default; a real delete has to say what it costs.
        const warn = document.createElement("div");
        warn.className = "confirm-row";
        const msg = document.createElement("span");
        msg.textContent = used
          ? `${t("del")} “${tagName(tg)}”? ${t("deleteTagUsed")} ${used} ${t("deleteTagUsed2")}`
          : `${t("del")} “${tagName(tg)}”?`;
        const yes = document.createElement("button");
        yes.className = "ghost danger";
        yes.textContent = t("del");
        yes.onclick = () => {
          state.tags = state.tags.filter((x) => x.id !== tg.id);
          for (const e of Object.values(state.entries)) {
            if (e.tags) e.tags = e.tags.filter((x) => x !== tg.id);
          }
          if (state.tagFilter === tg.id) state.tagFilter = null;
          state.confirmTagDelete = null;
          save(); renderTags();
        };
        const no = document.createElement("button");
        no.className = "ghost";
        no.textContent = t("cancel");
        no.onclick = () => { state.confirmTagDelete = null; renderTags(); };
        warn.append(msg, yes, no);
        list.appendChild(warn);
      }
    }
  }
}

function addTag() {
  const icon = document.getElementById("new-tag-icon").value.trim() || "⭐";
  const label = document.getElementById("new-tag-label").value.trim();
  const group = document.getElementById("new-tag-group").value;
  if (!label) return;
  state.tags.push({
    id: "t_" + Date.now().toString(36),   // permanent and independent of the
    label, icon, group,                   // label, so renaming never orphans
    order: state.tags.length, archived: false,
  });
  document.getElementById("new-tag-label").value = "";
  document.getElementById("new-tag-icon").value = "";
  save();
  renderTags();
}

function prettyDate(k) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale(),
    { weekday: "long", month: "long", day: "numeric" });
}

/* The detail panel doubles as the editor for any past day, so a mistyped
   mood doesn't have to stay wrong forever. Today is editable here too, and
   from the Today screen. */
function renderDetail() {
  const detail = document.getElementById("entry-detail");
  const k = state.selectedDay;
  const entry = k && state.entries[k];
  detail.hidden = !entry;
  if (!entry) return;

  detail.innerHTML = "";
  const mood = state.manifest.moods.find((m) => m.key === entry.mood);
  if (mood) detail.style.setProperty("--mood", mood.color);
  const h = document.createElement("h3");
  h.textContent = prettyDate(k);
  if (state.editing !== k) {
    const tag = document.createElement("span");
    tag.className = "mood-tag";
    tag.textContent = mood ? nameOf(mood) : entry.mood;
    h.append(" ", tag);
  }
  detail.appendChild(h);

  if (state.editing !== k) {
    // Entries saved before outfits were recorded fall back to the current one
    // rather than showing an undressed character.
    const worn = entry.outfit || state.outfit;
    const who = entry.character || state.character;
    const row = document.createElement("div");
    row.className = "detail-body";
    const fig = document.createElement("div");
    fig.className = "char entry-char";
    renderChar(fig, entry.mood, worn, who);
    const text = document.createElement("div");
    text.className = "detail-text";
    const p = document.createElement("p");
    p.textContent = entry.note || t("noNote");
    text.appendChild(p);
    row.append(fig, text);
    detail.appendChild(row);

    const chips = (entry.tags || []).map(tagById).filter(Boolean);
    if (chips.length) {
      const tr = document.createElement("div");
      tr.className = "tagrow shown";
      for (const t of chips) tr.appendChild(tagChip(t, true, null));
      text.appendChild(tr);
    }

    const actions = document.createElement("div");
    actions.className = "detail-actions";
    const edit = document.createElement("button");
    edit.className = "ghost";
    edit.textContent = t("edit");
    edit.onclick = () => {
      state.editing = k;
      state.editMood = entry.mood;
      state.editTags = (entry.tags || []).slice();
      renderDetail();
    };
    const del = document.createElement("button");
    del.className = "ghost danger";
    del.textContent = t("del");
    del.onclick = () => { state.confirmDelete = k; renderDetail(); };
    actions.append(edit, del);
    detail.appendChild(actions);

    // Confirmation is inline rather than a native confirm() dialog: webviews
    // and installed PWAs can suppress those, and a suppressed dialog returns
    // false, so the button just silently does nothing.
    if (state.confirmDelete === k) {
      const warn = document.createElement("div");
      warn.className = "confirm-row";
      const msg = document.createElement("span");
      msg.textContent = t("confirmDelete");
      const yes = document.createElement("button");
      yes.className = "ghost danger";
      yes.textContent = t("del");
      yes.onclick = () => {
        delete state.entries[k];
        save();
        state.selectedDay = null;
        state.editing = null;
        state.confirmDelete = null;
        if (k === todayKey()) { state.draftMood = null; }
        renderToday();
        renderHistory();
        renderCloset();
      };
      const no = document.createElement("button");
      no.className = "ghost";
      no.textContent = t("keep");
      no.onclick = () => { state.confirmDelete = null; renderDetail(); };
      warn.append(msg, yes, no);
      detail.appendChild(warn);
    }
    return;
  }

  // editing
  const picker = document.createElement("div");
  picker.className = "picker picker-sm";
  for (const m of state.manifest.moods) {
    const b = document.createElement("button");
    b.className = "mood";
    b.style.setProperty("--mood", m.color);
    b.setAttribute("aria-checked", String(m.key === state.editMood));
    b.appendChild(headChip(m.key));
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = nameOf(m);
    b.append(label);
    b.onclick = () => { state.editMood = m.key; renderDetail(); };
    picker.appendChild(b);
  }

  const tagBox = buildTagPicker(state.editTags || [], (id) => {
    toggleIn(state.editTags, id);
    renderDetail();
  });

  const ta = document.createElement("textarea");
  ta.rows = 3;
  ta.value = entry.note || "";
  ta.placeholder = "add a note…";

  const row = document.createElement("div");
  row.className = "detail-actions";
  const ok = document.createElement("button");
  ok.className = "ghost primary-ghost";
  ok.textContent = t("saveChanges");
  ok.onclick = () => {
    state.entries[k] = {
      mood: state.editMood, note: ta.value.trim(), tags: (state.editTags || []).slice(),
      // Editing a past day changes what you wrote, not what you wore.
      outfit: entry.outfit || Object.assign({}, state.outfit),
      character: entry.character || state.character,
    };
    save();
    state.editing = null;
    if (k === todayKey()) {
      state.draftMood = state.editMood;
      state.draftTags = (state.editTags || []).slice();
      renderToday();
    }
    renderHistory();
  };
  const cancel = document.createElement("button");
  cancel.className = "ghost";
  cancel.textContent = t("cancel");
  cancel.onclick = () => { state.editing = null; renderDetail(); };
  row.append(ok, cancel);

  detail.append(picker, tagBox, ta, row);
}

/* ── closet ──────────────────────────────────────────────────── */

function renderCloset() {
  const total = Object.keys(state.entries).length;
  document.getElementById("closet-progress").textContent =
    `${total} ${t("entriesLogged")}`;
  renderChar(document.getElementById("char-closet"), state.draftMood || "meh",
             state.outfit, state.character);

  const chars = document.getElementById("char-picker");
  chars.innerHTML = "";
  if (state.manifest.characters.length > 1) {
    for (const c of state.manifest.characters) {
      const b = document.createElement("button");
      b.className = "card char-card";
      b.setAttribute("aria-pressed", String(c.id === state.character));
      const fig = document.createElement("div");
      fig.className = "head";
      for (const l of layersFor("meh", { hat: null, top: null, bottom: null }, c.id)) {
        const img = new Image();
        img.src = ASSETS + l.src;
        img.alt = "";
        fig.appendChild(img);
      }
      const nm = document.createElement("span");
      nm.className = "name";
      nm.textContent = nameOf(c);
      b.append(fig, nm);
      b.onclick = () => setCharacter(c.id);
      chars.appendChild(b);
    }
  }

  const slots = document.getElementById("slots");
  slots.innerHTML = "";
  for (const [slot, title] of [["hat", "head"], ["top", "tops"], ["bottom", "bottoms"]]) {
    // Only what this character has art for. Anything else would render as
    // nothing at all, which reads as a broken item rather than an absent one.
    const items = state.manifest.items.filter(
      (i) => i.slot === slot && i.fits.includes(state.character));
    if (!items.length) continue;
    const box = document.createElement("div");
    box.className = "slot";
    const h = document.createElement("h2");
    h.textContent = t(title);
    box.appendChild(h);

    const grid = document.createElement("div");
    grid.className = "grid";

    const none = document.createElement("button");
    none.className = "card none-card";
    none.textContent = t("none");
    none.setAttribute("aria-pressed", String(!state.outfit[slot]));
    none.onclick = () => { state.outfit[slot] = null; save(); renderCloset(); renderToday(); };
    grid.appendChild(none);

    for (const it of items) {
      const locked = total < it.unlockAt;
      const card = document.createElement("button");
      card.className = "card" + (locked ? " locked" : "");
      card.setAttribute("aria-pressed", String(state.outfit[slot] === it.id));
      const img = new Image();
      img.src = ASSETS + it.icon;
      img.alt = nameOf(it);
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = nameOf(it);
      card.append(img, name);
      if (locked) {
        const lock = document.createElement("span");
        lock.className = "lock";
        lock.textContent = `${it.unlockAt - total} ${t("moreToUnlock")}`;
        card.appendChild(lock);
        card.disabled = true;
      } else {
        card.onclick = () => {
          state.outfit[slot] = state.outfit[slot] === it.id ? null : it.id;
          save(); renderCloset(); renderToday();
        };
      }
      grid.appendChild(card);
    }
    box.appendChild(grid);
    slots.appendChild(box);
  }
}

function setCharacter(id) {
  state.character = id;
  // Slots holding an item this body has no art for would silently render as
  // nothing, so clear them rather than leave an invisible "worn" item.
  for (const slot of ["hat", "top", "bottom"]) {
    const worn = state.outfit[slot];
    if (!worn) continue;
    const it = state.manifest.items.find((i) => i.id === worn);
    if (!it || !it.fits.includes(id)) state.outfit[slot] = null;
  }
  save();
  renderCloset();
  renderToday();
  renderHistory();
}

/* ── shell ───────────────────────────────────────────────────── */

function goto(name) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.dataset.screen !== name;
  // "tags" is reached from within a screen rather than the tab bar, so it
  // leaves the originating tab highlighted.
  const tab = name === "tags" ? state.returnTo : name;
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("active", b.dataset.goto === tab);
  if (name === "history") renderHistory();
  if (name === "closet") renderCloset();
  if (name === "tags") renderTags();
  window.scrollTo(0, 0);
}

// Re-render whichever screen is showing; used by shared controls like the tag
// picker, which lives on two screens and shouldn't care which one it's on.
function rerender() {
  const cur = document.querySelector(".screen:not([hidden])");
  if (!cur) return;
  if (cur.dataset.screen === "today") renderToday();
  if (cur.dataset.screen === "history") renderHistory();
  if (cur.dataset.screen === "tags") renderTags();
}

async function init() {
  load();
  // "no-cache" revalidates instead of blindly reusing a stored copy. Without
  // it the browser's HTTP cache can serve an old manifest after new items
  // ship, and every id it doesn't know silently renders as nothing. Still
  // offline-safe: the service worker answers when the network can't.
  state.manifest = await (await fetch(ASSETS + "items.json", { cache: "no-cache" })).json();

  state.entryDate = todayKey();
  document.getElementById("save").onclick = saveToday;
  document.getElementById("delete-today").onclick = () => {
    state.confirmDelete = state.entryDate || todayKey();
    renderToday();
  };
  document.getElementById("confirm-yes").onclick = deleteToday;
  document.getElementById("confirm-no").onclick = () => {
    state.confirmDelete = null;
    renderToday();
  };
  document.getElementById("entry-date").onchange = (e) => {
    // An empty or future value means the picker was cleared or fiddled with;
    // fall back to today rather than writing an entry under a bad key.
    const v = e.target.value;
    setEntryDate(v && v <= todayKey() ? v : todayKey());
  };
  document.getElementById("jump-today").onclick = () => setEntryDate(todayKey());
  document.getElementById("prev-month").onclick = () => {
    state.viewMonth = new Date(state.viewMonth.getFullYear(), state.viewMonth.getMonth() - 1, 1);
    renderHistory();
  };
  document.getElementById("next-month").onclick = () => {
    state.viewMonth = new Date(state.viewMonth.getFullYear(), state.viewMonth.getMonth() + 1, 1);
    renderHistory();
  };
  for (const b of document.querySelectorAll("#tabs button")) {
    b.onclick = () => goto(b.dataset.goto);
  }
  for (const b of document.querySelectorAll("#lang-toggle button")) {
    b.onclick = () => setLang(b.dataset.lang);
  }
  document.getElementById("tags-back").onclick = () => goto(state.returnTo || "today");
  document.getElementById("add-tag").onclick = addTag;
  document.getElementById("new-tag-label").onkeydown = (e) => {
    if (e.key === "Enter") addTag();
  };

  setLang(state.lang);        // paints static strings and the toggle state
  goto("today");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
