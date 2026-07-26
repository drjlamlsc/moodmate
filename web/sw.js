/* Offline support. The app shell is precached on install; assets are cached
   as they're first requested, so adding wardrobe items doesn't mean editing
   a hardcoded file list here. */

const CACHE = "moodmate-v1";
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

  // Images: cache first. They're content-addressed by filename and never
  // change in place, so there's nothing to invalidate.
  e.respondWith(
    caches.match(e.request).then((hit) => hit ||
      fetch(e.request).then((res) => remember(e.request, res)))
  );
});
