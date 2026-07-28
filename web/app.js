/* Moodmate — a local-only mood journal.
   Entries never leave the device: everything lives in localStorage, which is
   also why there is no account, no sync and no backend to pay for. */

const STORE = "moodmate.v1";
const ASSETS = "assets/";
const SCHEMA = 3;              // 1 = mood + note, 2 = adds activity tags,
                               // 3 = adds photos
const MAX_PHOTOS = 3;
const FULL_PX = 1600;          // stored longest edge, for the lightbox
const THUMB_PX = 400;          // stored longest edge, for lists
const FULL_Q = 0.82;
const THUMB_Q = 0.7;
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
  theme: null,                                   // null = follow the system
  character: "girl",                             // which body is worn
  entries: {},                                   // "YYYY-MM-DD" -> {mood, note, tags}
  tags: [],                                      // {id, label, icon, group, order, archived}
  outfit: { hat: null, top: null, bottom: null, face_acc: null },
  // Which closet sections are collapsed. Holds the closed ones, not the open
  // ones, so the empty default means everything shows — a new slot added later
  // appears rather than hiding until someone finds it.
  closetClosed: [],
  manifest: null,
  entryDate: null,                               // which day the entry screen edits
  draftMood: null,
  draftTags: null,
  draftPhotos: null,                             // photo ids on the open entry
  lightbox: null,                                // {ids, i} while a photo is open
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
      ? Object.assign({ hat: null, top: null, bottom: null, face_acc: null }, raw.outfit)
      : { hat: null, top: "hoodie", bottom: null, face_acc: null };
    state.tags = Array.isArray(raw.tags) && raw.tags.length ? raw.tags : seedTags();
    if (raw.lang === "en" || raw.lang === "zh") state.lang = raw.lang;
    if (raw.theme === "light" || raw.theme === "dark") state.theme = raw.theme;
    if (raw.character) state.character = raw.character;
    if (Array.isArray(raw.closetClosed)) state.closetClosed = raw.closetClosed;

    // Migration to schema 2. Entries written before tags existed simply have
    // none; give them an empty array so nothing downstream has to special-case
    // a missing field. Runs once and is invisible.
    if (!raw.version || raw.version < 3) {
      for (const e of Object.values(state.entries)) {
        if (!Array.isArray(e.tags)) e.tags = [];       // schema 2: tags
        if (!Array.isArray(e.photos)) e.photos = [];   // schema 3: photos
      }
      save();
    }
  } catch {
    /* Corrupt or unreadable storage shouldn't brick the app; start fresh
       rather than throwing before the first render. */
    state.tags = seedTags();
    state.outfit = { hat: null, top: "hoodie", bottom: null, face_acc: null };
  }
}

function save() {
  localStorage.setItem(STORE, JSON.stringify({
    version: SCHEMA, lang: state.lang, theme: state.theme,
    character: state.character, entries: state.entries,
    tags: state.tags, outfit: state.outfit,
    closetClosed: state.closetClosed,
  }));
}

/* ── photos ──────────────────────────────────────────────────────
   Photos live in IndexedDB, not in the entry. localStorage holds about 5MB
   for the whole origin and stores strings, so a photo would have to be
   base64 — a third larger again. One phone photo would take most of the
   budget and three would exceed it, taking the journal text down with them.
   IndexedDB stores Blobs natively and its quota is orders of magnitude
   larger. The entry keeps only a list of ids.

   Each photo is stored twice: a full copy for the lightbox and a thumbnail
   for lists. A list of thirty entries would otherwise decode ninety
   full-size images to draw them 60px wide. */

const PHOTO_DB = "moodmate-photos";
let photoDB = null;

function openPhotoDB() {
  if (photoDB) return Promise.resolve(photoDB);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PHOTO_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("photos")) {
        req.result.createObjectStore("photos", { keyPath: "id" });
      }
    };
    req.onsuccess = () => { photoDB = req.result; resolve(photoDB); };
    req.onerror = () => reject(req.error);
  });
}

function photoTx(mode, fn) {
  return openPhotoDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("photos", mode);
    const req = fn(tx.objectStore("photos"));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  }));
}

const photoPut = (rec) => photoTx("readwrite", (s) => s.put(rec));
const photoGet = (id) => photoTx("readonly", (s) => s.get(id));
const photoDel = (id) => photoTx("readwrite", (s) => s.delete(id));
const photoKeys = () => photoTx("readonly", (s) => s.getAllKeys());

// Object URLs are cached per id: a photo can appear on the list, the entry
// and the lightbox at once, and minting a URL per <img> would leak one each
// time the list re-renders. Revoked only when the photo itself is deleted.
const photoURLs = new Map();

async function photoURL(id, which) {
  const k = id + ":" + which;
  if (photoURLs.has(k)) return photoURLs.get(k);
  const rec = await photoGet(id);
  if (!rec || !rec[which]) return null;
  const url = URL.createObjectURL(rec[which]);
  photoURLs.set(k, url);
  return url;
}

function forgetPhotoURL(id) {
  for (const which of ["full", "thumb"]) {
    const k = id + ":" + which;
    if (photoURLs.has(k)) {
      URL.revokeObjectURL(photoURLs.get(k));
      photoURLs.delete(k);
    }
  }
}

// Downscale in a canvas before storing. Phone cameras produce 3-6MB files and
// nothing here is ever shown larger than a phone screen, so keeping the
// original would cost storage for detail that is never drawn.
function scaleToBlob(img, maxPx, quality) {
  const s = Math.min(1, maxPx / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * s);
  c.height = Math.round(img.height * s);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, "image/jpeg", quality));
}

async function addPhotoFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const [full, thumb] = await Promise.all([
      scaleToBlob(img, FULL_PX, FULL_Q),
      scaleToBlob(img, THUMB_PX, THUMB_Q),
    ]);
    const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await photoPut({ id, full, thumb, ts: Date.now() });
    return id;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// A photo is only reachable through an entry, so anything no entry references
// is dead weight — left behind by a delete that failed midway, or by removing
// a photo from a draft that was never saved. Swept once at startup.
async function sweepPhotos() {
  try {
    const used = new Set();
    for (const e of Object.values(state.entries)) {
      for (const id of e.photos || []) used.add(id);
    }
    for (const id of (await photoKeys()) || []) {
      if (!used.has(id)) await photoDel(id);
    }
  } catch { /* a failed sweep costs space, never correctness */ }
}

/* ── pull to refresh ─────────────────────────────────────────────
   An installed PWA has no address bar, no reload button, and no Safari
   pull-to-refresh — that gesture only exists in the browser. So when an asset
   does go stale there is nothing the user can do about it short of deleting
   and reinstalling the app. This is that missing control. */

// Indicator travel, not finger travel: the 0.45 resistance below means arming
// the gesture takes about 245px of actual drag, roughly a third of a phone
// screen. Deliberately long — refreshing throws away the offline copy, and
// this fires on a gesture people also use for ordinary scrolling.
const PULL_TRIGGER = 110;   // px of travel before the gesture arms
const PULL_MAX = 150;       // further than this the indicator stops following
let pullY = 0, pullFrom = null, pulling = false;

function pullEl() { return document.getElementById("pull"); }

function setPull(px, armed) {
  const el = pullEl();
  el.classList.remove("snap");
  el.style.transform = "translateY(" + (px - 64) + "px)";
  el.classList.toggle("armed", px > 6);
  // The page follows the finger too. Without this the indicator slides over a
  // stationary header and reads as a stray label rather than a drag.
  const app = document.getElementById("app");
  app.classList.remove("snap");
  app.style.transform = "translateY(" + px + "px)";
  document.getElementById("pull-text").textContent =
    t(armed ? "releaseToRefresh" : "pullToRefresh");
}

function resetPull() {
  const el = pullEl(), app = document.getElementById("app");
  el.classList.add("snap");
  el.style.transform = "";
  el.classList.remove("armed");
  app.classList.add("snap");
  app.style.transform = "";
  pullY = 0; pullFrom = null; pulling = false;
}

/* Everything cached is dropped, then the page is reloaded. Destructive to the
   offline copy, which is why it is only ever a deliberate gesture: the next
   load refills it from the network. */
async function refreshAssets() {
  const el = pullEl(), app = document.getElementById("app");
  el.classList.remove("snap", "armed");
  el.classList.add("busy");
  el.style.transform = "";
  app.classList.add("snap");
  app.style.transform = "translateY(64px)";   // hold under the spinner
  document.getElementById("pull-text").textContent = t("refreshing");
  try {
    for (const k of await caches.keys()) await caches.delete(k);
    const regs = await navigator.serviceWorker.getRegistrations();
    // Unregister rather than update(): update() can leave the old worker
    // controlling this page, which is the state we are trying to escape.
    for (const r of regs) await r.unregister();
  } catch { /* refuse to get stuck on the indicator if any of it fails */ }
  location.reload();
}

function initPull() {
  const scrolled = () => window.scrollY || document.documentElement.scrollTop || 0;

  addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || scrolled() > 0 || state.lightbox) return;
    pullFrom = e.touches[0].clientY;
    pulling = false;
  }, { passive: true });

  addEventListener("touchmove", (e) => {
    if (pullFrom === null || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - pullFrom;
    // An upward move, or any scroll away from the top, hands the gesture back
    // to the page — this must never fight normal scrolling.
    if (dy <= 0 || scrolled() > 0) { if (pulling) resetPull(); pullFrom = null; return; }
    pulling = true;
    // Resistance: the indicator moves a fraction of the finger, so the pull
    // feels weighted and can't be triggered by an idle flick.
    pullY = Math.min(PULL_MAX, dy * 0.45);
    setPull(pullY, pullY >= PULL_TRIGGER);
    e.preventDefault();          // suppress the rubber-band while pulling
  }, { passive: false });

  addEventListener("touchend", () => {
    if (!pulling) { pullFrom = null; return; }
    if (pullY >= PULL_TRIGGER) refreshAssets();
    else resetPull();
  }, { passive: true });

  addEventListener("touchcancel", resetPull, { passive: true });
}

/* ── theme ───────────────────────────────────────────────────────
   state.theme is null until the user chooses, so a first run follows the
   phone. After that the choice is explicit and sticks, including the case of
   wanting light while the system is dark. */

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
const effectiveTheme = () => state.theme || (systemDark() ? "dark" : "light");

function applyTheme() {
  const dark = effectiveTheme() === "dark";
  // Absent means "follow the system"; the media query handles it from there.
  if (state.theme) document.documentElement.dataset.theme = state.theme;
  else delete document.documentElement.dataset.theme;
  // The iOS status bar reads this, so leaving it stale puts a pale bar above
  // a dark app.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#1b1720" : "#f5eefa");
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = dark ? "☀" : "☾";   // what tapping switches to
}

function toggleTheme() {
  state.theme = effectiveTheme() === "dark" ? "light" : "dark";
  save();
  applyTheme();
}

/* ── language ────────────────────────────────────────────────── */

/* Asset URLs carry the build stamp from the manifest. Item art is replaced
   under an unchanged filename whenever a render is improved — item_jeans.png
   has been three different drawings — so a bare filename is stale-able at two
   independent layers: the service worker's cache and the browser's own HTTP
   cache. Clearing one still leaves the other. A URL that changes with the
   content is a new URL to both of them, which is the only fix that covers
   both. items.json itself is fetched with cache:"no-cache", so the current
   stamp is always discovered. */
const asset = (f) => ASSETS + f + (state.manifest && state.manifest.build
                                   ? "?v=" + state.manifest.build : "");

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
  // Above the expression, below hats: a frame covers the eyes, a brim covers it.
  if (outfit.face_acc) push(outfit.face_acc, "face_acc");
  if (outfit.hat) push(outfit.hat, "hat");
  return out.sort((a, b) => a.z - b.z);
}

// `rig` splits the drawing into a head and a body that animate separately, for
// the previews big enough to be worth it. Left off, the layers are stacked flat
// as before — the entry list draws one of these per row, and doubling its DOM
// to animate something it never animates would be a waste.
function renderChar(el, mood, outfit, character, rig) {
  // Both drive the idle squash, in CSS: one picks its tempo and depth, the
  // other where the neck is. They go on the container, which survives this
  // function; the layers below are replaced on every change of clothes, so an
  // animation on them would restart mid-motion each time.
  el.dataset.mood = mood || "meh";
  el.dataset.character = character || state.character;
  el.innerHTML = "";

  const layers = layersFor(mood, outfit, character);
  const stack = (parent) => {
    for (const l of layers) {
      const img = new Image();
      img.src = asset(l.src);
      img.alt = "";
      parent.appendChild(img);
    }
  };

  if (!rig) { stack(el); return; }

  // Each half holds the *whole* stack and shows its own slice of it, rather
  // than the head and body being separate art. base.png is one image with both
  // in it, and every cut line crosses either hair or a collar — a garment that
  // spans the neck stays continuous this way, because both halves draw it.
  const body = document.createElement("div");
  body.className = "rig-body";
  const head = document.createElement("div");
  head.className = "rig-head";
  stack(body);
  stack(head);
  el.append(body, head);
}

// `tight` crops to the face alone. At calendar size a full head crop spends
// most of its pixels on hair and shoulders, leaving the expression — the only
// thing that distinguishes one day from another — a few pixels across.
function headChip(mood, tight, character) {
  const wrap = document.createElement("div");
  wrap.className = "head" + (tight ? " tight" : "");
  for (const l of layersFor(mood, { hat: null, top: null, bottom: null }, character)) {
    const img = new Image();
    img.src = asset(l.src);
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
  if (state.draftPhotos === null) state.draftPhotos = entry ? (entry.photos || []).slice() : [];

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

  renderChar(document.getElementById("char"), state.draftMood, state.outfit,
             state.character, true);

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
  renderPhotoEditor();
  document.getElementById("save").textContent =
    t(entry ? "updateEntry" : (isToday ? "saveToday" : "saveEntry"));

  const asking = !!entry && state.confirmDelete === day;
  document.getElementById("delete-today").hidden = !entry || asking;
  document.getElementById("confirm-delete").hidden = !asking;
}

function renderPhotoEditor() {
  const row = document.getElementById("photos-today");
  row.innerHTML = "";
  const ids = state.draftPhotos || [];

  for (const id of ids) {
    const cell = document.createElement("div");
    cell.className = "photo-cell";
    const img = new Image();
    img.alt = "";
    photoURL(id, "thumb").then((u) => { if (u) img.src = u; });
    img.onclick = () => openLightbox(ids, ids.indexOf(id));
    const rm = document.createElement("button");
    rm.className = "photo-remove";
    rm.type = "button";
    rm.textContent = "×";
    rm.setAttribute("aria-label", t("removePhoto"));
    // Dropped from the draft only. The file is swept at next startup if the
    // entry is saved without it — deleting here would lose the photo for good
    // if the edit is then abandoned.
    rm.onclick = () => {
      state.draftPhotos = ids.filter((x) => x !== id);
      renderPhotoEditor();
    };
    cell.append(img, rm);
    row.appendChild(cell);
  }

  if (ids.length < MAX_PHOTOS) {
    const add = document.createElement("button");
    add.className = "photo-add";
    add.type = "button";
    add.innerHTML = '<span aria-hidden="true">＋</span>';
    const cap = document.createElement("i");
    cap.textContent = ids.length ? t("photoLimit") : t("addPhoto");
    add.appendChild(cap);
    add.onclick = () => document.getElementById("photo-input").click();
    row.appendChild(add);
  }
}

async function onPhotoPicked(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = "";                   // so re-picking the same file fires
  const room = MAX_PHOTOS - (state.draftPhotos || []).length;
  for (const f of files.slice(0, room)) {
    try {
      state.draftPhotos.push(await addPhotoFile(f));
    } catch { /* an unreadable file is skipped, not fatal */ }
    renderPhotoEditor();
  }
}

function openLightbox(ids, i) {
  state.lightbox = { ids: ids.slice(), i };
  renderLightbox();
}

function renderLightbox() {
  const box = document.getElementById("lightbox");
  const lb = state.lightbox;
  box.hidden = !lb;
  box.innerHTML = "";
  if (!lb) return;

  const img = new Image();
  img.className = "lightbox-img";
  img.alt = "";
  photoURL(lb.ids[lb.i], "full").then((u) => { if (u) img.src = u; });
  box.appendChild(img);

  if (lb.ids.length > 1) {
    const dots = document.createElement("div");
    dots.className = "lightbox-dots";
    lb.ids.forEach((_, n) => {
      const d = document.createElement("button");
      d.className = "dot" + (n === lb.i ? " on" : "");
      d.type = "button";
      d.onclick = (ev) => { ev.stopPropagation(); state.lightbox.i = n; renderLightbox(); };
      dots.appendChild(d);
    });
    box.appendChild(dots);
  }

  const close = document.createElement("button");
  close.className = "lightbox-close";
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", t("closePhoto"));
  box.appendChild(close);
  box.onclick = () => { state.lightbox = null; renderLightbox(); };
}

function setEntryDate(k) {
  state.entryDate = k;
  state.draftMood = null;                // let the chosen day's own mood, tags
  state.draftTags = null;                // and photos load
  state.draftPhotos = null;
  document.getElementById("note").blur();
  renderToday();
}

function deleteToday() {
  const k = state.entryDate || todayKey();
  if (!state.entries[k]) return;
  const gone = (state.entries[k].photos || []).slice();
  delete state.entries[k];
  save();
  for (const id of gone) { forgetPhotoURL(id); photoDel(id).catch(() => {}); }
  state.draftMood = null;
  state.draftTags = null;
  state.draftPhotos = null;
  state.confirmDelete = null;
  document.getElementById("note").value = "";
  renderToday();
  renderHistory();
  renderList();
  renderCloset();
}

function saveToday() {
  const note = document.getElementById("note").value.trim();
  const day = state.entryDate || todayKey();
  const dropped = ((state.entries[day] || {}).photos || [])
    .filter((id) => !(state.draftPhotos || []).includes(id));
  state.entries[day] = {
    mood: state.draftMood, note, tags: (state.draftTags || []).slice(),
    photos: (state.draftPhotos || []).slice(),
    // Snapshot, not a reference: changing clothes tomorrow must not restyle
    // what you wore today. This is what makes the history a record.
    outfit: Object.assign({}, state.outfit),
    character: state.character,
  };
  save();
  // Only once the entry without them is committed, so a failure here leaves
  // an orphan for the sweep rather than an entry pointing at a missing photo.
  for (const id of dropped) { forgetPhotoURL(id); photoDel(id).catch(() => {}); }
  const hint = document.getElementById("saved-hint");
  hint.hidden = false;
  setTimeout(() => { hint.hidden = true; }, 1600);
  renderToday();
  renderCloset();
}

/* ── entry list ──────────────────────────────────────────────────
   The calendar answers "what did this month look like"; this answers "what
   actually happened". So it shows the things a grid has no room for: the
   character in the outfit worn that day, the tags, and enough of the note to
   recognise the entry. Tapping a row opens that day on Today, which is
   already the full editor — there is one entry per day, so editing it is the
   only thing a row can usefully do. */

function renderList() {
  const wrap = document.getElementById("entry-list");
  if (!wrap) return;
  wrap.innerHTML = "";

  const keys = Object.keys(state.entries).sort().reverse();
  if (!keys.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = t("noEntries");
    wrap.appendChild(empty);
    return;
  }

  let month = null;
  for (const k of keys) {
    const entry = state.entries[k];
    const [y, m, d] = k.split("-").map(Number);
    const date = new Date(y, m - 1, d);

    const stamp = y + "-" + m;
    if (stamp !== month) {
      month = stamp;
      const h = document.createElement("h2");
      h.className = "list-month";
      h.textContent = date.toLocaleDateString(locale(), { month: "long", year: "numeric" });
      wrap.appendChild(h);
    }

    const mood = state.manifest.moods.find((x) => x.key === entry.mood);
    const row = document.createElement("button");
    row.className = "list-row";
    row.type = "button";
    if (mood) row.style.setProperty("--mood", mood.color);
    row.onclick = () => { setEntryDate(k); goto("today"); };

    // Entries saved before outfits were recorded fall back to the current one
    // rather than showing an undressed character.
    const fig = document.createElement("div");
    fig.className = "char list-char";
    renderChar(fig, entry.mood, entry.outfit || state.outfit, entry.character || state.character);
    row.appendChild(fig);

    const body = document.createElement("div");
    body.className = "list-body";

    const head = document.createElement("div");
    head.className = "list-head";
    const day = document.createElement("strong");
    day.textContent = date.toLocaleDateString(locale(), { weekday: "short", day: "numeric" });
    const name = document.createElement("span");
    name.className = "mood-tag";
    name.textContent = mood ? nameOf(mood) : entry.mood;
    head.append(day, name);
    body.appendChild(head);

    if (entry.note) {
      const p = document.createElement("p");
      p.className = "list-note";
      p.textContent = entry.note;
      body.appendChild(p);
    }

    const chips = (entry.tags || []).map(tagById).filter(Boolean);
    if (chips.length) {
      const tr = document.createElement("div");
      tr.className = "tagrow shown list-tags";
      for (const tg of chips) tr.appendChild(tagChip(tg, true, null));
      body.appendChild(tr);
    }

    const pics = entry.photos || [];
    if (pics.length) {
      const pr = document.createElement("div");
      pr.className = "list-photos";
      for (const id of pics) {
        const img = new Image();
        img.alt = "";
        img.loading = "lazy";
        photoURL(id, "thumb").then((u) => { if (u) img.src = u; });
        // The row opens the editor; a photo should open the photo instead.
        img.onclick = (ev) => { ev.stopPropagation(); openLightbox(pics, pics.indexOf(id)); };
        pr.appendChild(img);
      }
      body.appendChild(pr);
    }

    row.appendChild(body);
    wrap.appendChild(row);
  }
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
    renderChar(fig, entry.mood, worn, who, true);
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
        const gone = (state.entries[k].photos || []).slice();
        delete state.entries[k];
        save();
        for (const id of gone) { forgetPhotoURL(id); photoDel(id).catch(() => {}); }
        state.selectedDay = null;
        state.editing = null;
        state.confirmDelete = null;
        if (k === todayKey()) { state.draftMood = null; state.draftPhotos = null; }
        renderToday();
        renderHistory();
        renderList();
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
  // Deliberately unrigged, so it holds still. The closet is where you are
  // judging how a garment sits, and a moving figure fights that.
  renderChar(document.getElementById("char-closet"), state.draftMood || "meh",
             state.outfit, state.character);

  // A toggle in the corner of the preview rather than a row of portrait cards.
  // Which body you are is one binary choice made rarely; it was taking a whole
  // section above the wardrobe, which is the part people actually browse.
  const chars = document.getElementById("char-toggle");
  chars.innerHTML = "";
  chars.hidden = state.manifest.characters.length < 2;
  for (const c of state.manifest.characters) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = c.id === state.character ? "on" : "";
    b.setAttribute("aria-pressed", String(c.id === state.character));
    b.textContent = nameOf(c);
    b.onclick = () => setCharacter(c.id);
    chars.appendChild(b);
  }

  const slots = document.getElementById("slots");
  slots.innerHTML = "";
  // Clothes first, accessories after: tops and bottoms are what gets changed
  // most, and they were sitting below two accessory sections that are picked
  // once and left alone.
  for (const [slot, title] of [["top", "tops"], ["bottom", "bottoms"], ["face_acc", "faceAcc"], ["hat", "head"]]) {
    // Only what this character has art for. Anything else would render as
    // nothing at all, which reads as a broken item rather than an absent one.
    const items = state.manifest.items.filter(
      (i) => i.slot === slot && i.fits.includes(state.character));
    if (!items.length) continue;
    // <details> rather than a hand-rolled toggle: it collapses without script,
    // and carries the keyboard and screen-reader behaviour a div with a click
    // handler would have to reimplement.
    //
    // State lives outside the element because renderCloset() rebuilds the whole
    // list whenever anything is worn, which would otherwise spring every
    // section back open the moment you picked something.
    const box = document.createElement("details");
    box.className = "slot";
    box.open = !state.closetClosed.includes(slot);
    const h = document.createElement("summary");
    h.textContent = t(title);
    box.appendChild(h);
    // On the summary's click, not the element's toggle. `toggle` also fires for
    // the programmatic open above, and it fires asynchronously, so events left
    // over from a previous render land on state that has moved on. A click is
    // only ever a person. The browser flips `open` after this handler, so the
    // state being recorded is the opposite of what it currently reads.
    h.onclick = () => {
      const closed = state.closetClosed.filter((s) => s !== slot);
      if (box.open) closed.push(slot);
      state.closetClosed = closed;
      save();
    };

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
      img.src = asset(it.icon);
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
  for (const slot of ["hat", "face_acc", "top", "bottom"]) {
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
  if (name === "list") renderList();
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
  if (cur.dataset.screen === "list") renderList();
  if (cur.dataset.screen === "tags") renderTags();
}

async function init() {
  load();
  // "no-cache" revalidates instead of blindly reusing a stored copy. Without
  // it the browser's HTTP cache can serve an old manifest after new items
  // ship, and every id it doesn't know silently renders as nothing. Still
  // offline-safe: the service worker answers when the network can't.
  state.manifest = await (await fetch(ASSETS + "items.json", { cache: "no-cache" })).json();

  // The page has just read the current build. If a cache is keyed to a
  // different one, drop it — without waiting for the service worker to notice.
  // That wait is exactly what failed on iOS: the shell is network-first, so
  // new code arrived and dark mode and photos worked, while the old worker
  // kept serving old images from a cache it had no reason to invalidate.
  if (state.manifest.build && window.caches) {
    const want = "moodmate-" + state.manifest.build;
    caches.keys().then((ks) => ks.forEach((k) => { if (k !== want) caches.delete(k); }))
                 .catch(() => {});
  }

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
  document.getElementById("photo-input").onchange = onPhotoPicked;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.lightbox) { state.lightbox = null; renderLightbox(); }
  });
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

  document.getElementById("theme-toggle").onclick = toggleTheme;
  // Only fires while state.theme is null, i.e. while we're following along.
  window.matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", () => { if (!state.theme) applyTheme(); });

  applyTheme();
  initPull();
  setLang(state.lang);        // paints static strings and the toggle state
  goto("today");
  sweepPhotos();              // after the first paint; nothing waits on it

  if ("serviceWorker" in navigator) {
    // updateViaCache:"none" keeps sw.js itself out of the HTTP cache. The
    // worker is what decides whether everything else is stale, so serving a
    // stale copy of it means a deploy can never take effect — the one file
    // that must always come from the network.
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
  }
}

init();
