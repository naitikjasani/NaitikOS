import 'server-only';

import type { cookies } from 'next/headers';

import type { CookieAccessor } from './clients';

/**
 * Bridge between Next's cookie store and the Supabase cookie accessor.
 *
 * Separated from `clients.ts` for two reasons. `clients.ts` is imported by
 * `middleware.ts`, which runs on the edge and must not pull in `next/headers`.
 * And the `server-only` import at the top of this file makes a mistaken import
 * from a client component a *build* error rather than a runtime one — this
 * module reaches the session cookie, which is the credential.
 *
 * The store type is derived from Next's own return type rather than
 * hand-written. A hand-written structural type looked right and did not match:
 * Next's `set` is overloaded, and `Partial<SerializeOptions>` from
 * `@supabase/ssr` is not assignable to Next's `Partial<ResponseCookie>`.
 * Deriving it means a Next upgrade that changes the shape fails here, loudly,
 * instead of silently accepting a signature that no longer matches.
 */
type NextCookieStore = Awaited<ReturnType<typeof cookies>>;

/**
 * A writable accessor, for route handlers.
 *
 * Exists so the four auth route handlers do not each rebuild it — the
 * milestone's "no duplicated auth logic" applies to plumbing too, and a
 * per-handler copy is exactly where one ends up with different cookie
 * attributes from the other three.
 */
export function createWritableCookieAccessor(store: NextCookieStore): CookieAccessor {
  return {
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    setAll: (toSet) => {
      for (const { name, value, options } of toSet) {
        // Branching rather than passing `options` through: with
        // `exactOptionalPropertyTypes`, an explicit `undefined` is a distinct
        // value from an absent argument, and Next's overloads reject it.
        if (options === undefined) store.set(name, value);
        else store.set(name, value, options);
      }
    },
  };
}
