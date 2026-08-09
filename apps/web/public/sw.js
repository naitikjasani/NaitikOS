/**
 * The service worker.
 *
 * §12 week 2 asks for "PWA: manifest, service worker, installable, offline
 * shell", and §5.7's requirement is concrete: "The PWA must be fully usable in
 * a gym basement with no signal."
 *
 * ## What this deliberately does not do
 *
 * **It does not cache API responses, and it does not queue writes.** Both are
 * tempting and both would be wrong here.
 *
 * Reads are cached by TanStack Query (`lib/query/QueryProvider.tsx`), which
 * knows what a query *is* — a service worker sees only URLs, so its cache
 * cannot be invalidated by a mutation and would serve a stale Daily Close after
 * one was submitted. Two caches with different invalidation rules is one cache
 * too many.
 *
 * Writes go to the IndexedDB outbox (`lib/offline/outbox.ts`), which is durable
 * before the request is attempted. A service worker's Background Sync would be
 * a *second* queue with its own retry policy, and §5.7's guarantee — "a failed
 * drain must never silently discard a write" — is only checkable with one.
 *
 * So this file does exactly one job: **serve the application shell offline**,
 * so that opening the app with no signal produces the app rather than the
 * browser's dinosaur.
 *
 * ## Plain JavaScript, in `public/`
 *
 * Not TypeScript, and not built. A service worker is served from the origin
 * root with its own scope, and putting it through the bundler means its URL and
 * its contents depend on the build — which is how a stale worker outlives a
 * deploy. One file, no build step, no surprises.
 */

/**
 * Bumping this deletes every previous cache on activate.
 *
 * The version is the whole invalidation strategy, and it is deliberately crude:
 * §5.15 deploys the app as a unit, so a partially-updated shell is not a state
 * worth supporting.
 */
const CACHE_VERSION = 'naitikos-shell-v1';

/**
 * What is pre-cached.
 *
 * The offline page only. Pre-caching the real routes is not possible — they are
 * server-rendered and per-request (`force-dynamic`), so their HTML is not a
 * static asset and caching one would pin a signed-in render of a page that must
 * be re-authorised on every visit.
 */
const PRECACHE = ['/offline'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      // Activate immediately rather than waiting for every tab to close. A
      // worker that waits can be a version behind for days on a device the
      // operator never fully closes, which is every phone.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only same-origin GETs. A POST must never be served from a cache, and a
  // cross-origin request is Supabase's — intercepting it would put a session
  // refresh through a cache, which is a security problem rather than a bug.
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  /*
   * API requests are never cached, and never served stale.
   *
   * Falling through to the network means an offline API call fails — which is
   * correct: the query client has the cached answer and knows how old it is,
   * and the outbox has the write. A service-worker cache here would give the
   * app a *third* opinion about the record's contents.
   */
  if (new URL(request.url).pathname.startsWith('/api/')) return;

  /*
   * Navigations: network first, offline page as the fallback.
   *
   * Network-first rather than cache-first because every page in this app is
   * server-rendered per request and carries authorisation state. Serving a
   * cached navigation would show a signed-in page to a session that has since
   * been revoked.
   */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_VERSION);
        const offline = await cache.match('/offline');
        return offline ?? new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }),
    );
    return;
  }

  /*
   * Static assets: cache-first, then network, then populate.
   *
   * Safe because Next fingerprints these filenames — a changed asset has a
   * changed URL, so a cached one can never be stale. Applying the same strategy
   * to anything unfingerprinted would be a bug.
   */
  if (request.url.includes('/_next/static/') || request.destination === 'font') {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            // Cloned before the body is consumed: a Response body may be read
            // exactly once, and returning one that a cache has already drained
            // produces an empty asset with no error.
            const copy = response.clone();
            void caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
  }
});
