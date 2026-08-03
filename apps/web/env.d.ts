/**
 * Ambient declarations for the public environment variables.
 *
 * These exist to resolve a genuine conflict between two correct rules.
 *
 * `noPropertyAccessFromIndexSignature` (tsconfig base) requires bracket access
 * for anything reached through an index signature, and `process.env` is one.
 * But Next's build-time inlining of `NEXT_PUBLIC_*` is a literal textual
 * substitution of `process.env.NEXT_PUBLIC_X` — **dot notation only**. Written
 * as `process.env['NEXT_PUBLIC_X']`, the value is not replaced, and the browser
 * receives `undefined` with no error at build time and no error at runtime
 * until something reads it.
 *
 * Declaring the variables here makes them real properties rather than index
 * signature members, so dot access satisfies the compiler and the inlining
 * works. It also documents the complete set of public variables in one place.
 *
 * Only `NEXT_PUBLIC_*` belongs here. Server variables stay behind
 * `serverEnv()`, which validates them and throws if called in the browser —
 * declaring them ambiently would make a leak into a client bundle typecheck
 * cleanly, which is the opposite of what is wanted.
 */

declare namespace NodeJS {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- Declaration merging into NodeJS.ProcessEnv requires `interface`; a `type` alias cannot merge.
  interface ProcessEnv {
    /** Supabase project URL. Public: it is the origin the browser talks to. */
    readonly NEXT_PUBLIC_SUPABASE_URL: string;
    /**
     * Supabase anon key. Public, and safe only because migration 0004 enables
     * RLS with no policies and revokes the PostgREST grants.
     */
    readonly NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
    /** The origin this deployment serves. Used for CSRF origin checking. */
    readonly NEXT_PUBLIC_SITE_URL: string;
  }
}
