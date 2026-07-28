/* Offline support. The app shell is precached on install; assets are cached
   as they're first requested, so adding wardrobe items doesn't mean editing
   a hardcoded file list here. */

// Stamped by export_web.py from a hash of the built assets. It must change
// whenever any asset does, because the image rule below is cache-first and a
// cache keyed by a constant name is never invalidated.
const CACHE = "moodmate-4938b13197";
const SHELL = [
  ".", "index.html", "styles.css", "app.js",
  "manifest.webmanifest", "assets/items.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isShell = (url) => /\.(html|css|js|json|webmanifest)$/.test(url.pathname) ||
                         url.pathname === "/" || url.pathname.endsWith("/");

function remember(request, response) {
  // Only cache our own successful responses; an opaque or errored one would
  // poison the cache and break the page while offline.
  if (response.ok && new URL(request.url).origin === self.location.origin) {
    const copy = response.clone();
    caches.open(CACHE).then((c) => c.put(request, copy));
  }
  return response;
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  // Code and data: network first, so a deploy takes effect on the next load.
  // Cache-first here means a user who once loaded the app is pinned to that
  // version forever — and worse, a new index.html paired with a stale app.js
  // is a broken page rather than an old one.
  if (isShell(url)) {
    e.respondWith(
      fetch(e.request).then((res) => remember(e.request, res))
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match("index.html")))
    );
    return;
  }

  // Images: cache first. They are NOT content-addressed — an item's art gets
  // replaced under the same filename every time a render is improved — so what
  // invalidates them is the build-stamped cache name above, which drops the
  // whole old cache on activate.
  e.respondWith(
    caches.match(e.request).then((hit) => hit ||
      fetch(e.request).then((res) => remember(e.request, res)))
  );
});
