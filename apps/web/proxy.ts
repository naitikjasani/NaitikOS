/**
 * The proxy — Next 16's name for what was `middleware.ts`. The one place a
 * session is refreshed and a route is guarded.
 *
 * Four jobs, in this order, and the order is not arbitrary:
 *
 *   1. **Refresh the session.** Only middleware can. A Server Component cannot
 *      write cookies, so a token refreshed during render is discarded — see
 *      `lib/supabase/clients.ts`. Everything downstream depends on this having
 *      happened, which is why it runs first and unconditionally.
 *   2. **Guard the route.** Default deny (`lib/auth/routes.ts`).
 *   3. **Seed the CSRF token** if absent, so a form rendered on the next
 *      response has one to submit.
 *   4. **Attach security headers**, including the per-request CSP nonce
 *      (§5.14). Last, so every response above gets them.
 *
 * ## What this deliberately does *not* do
 *
 * It does not check the allowlist, and it does not resolve a role. Both need a
 * database, and the edge runtime has no Postgres driver. More importantly, a
 * middleware that authorizes would be a *second* authorization site, and §5.4
 * wants exactly one — `authorize()` in core, reached through the guards.
 *
 * So this is a coarse gate: "is there a session at all?" A caller with a valid
 * Supabase session but no allowlist entry passes here and is refused by
 * `getAuthState()` on the very next step, which renders as anonymous. That is
 * correct behaviour, not a hole — but it does mean **the proxy must never be
 * the only thing standing between a request and data.**
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import {
  CSRF_COOKIE_OPTIONS,
  buildSecurityHeaders,
  generateCsrfToken,
  generateNonce,
} from '@naitikos/api';

import { clientEnv, isDevelopment } from './lib/env';
import { SESSION_COOKIE_OPTIONS } from './lib/supabase/clients';
import {
  DEFAULT_AUTHENTICATED_PATH,
  SIGN_IN_PATH,
  isApiRoute,
  isPublicRoute,
  isUnguarded,
  signInUrlFor,
} from './lib/auth/routes';

/** Header carrying the CSP nonce to the render layer. */
const NONCE_HEADER = 'x-naitikos-nonce';

/**
 * The request headers to forward onward, carrying the nonce.
 *
 * **This has to be a *request* header.** `headers()` in a Server Component reads
 * the headers of the incoming request, not the ones on the response — so setting
 * the nonce only on the response (which is what this file used to do) meant
 * `RootLayout` read `null`, fell back to `''`, and rendered the pre-paint theme
 * script with an empty nonce. Two symptoms followed: a hydration mismatch on
 * `<script nonce>`, and — the one that matters — the script being **blocked by
 * the CSP**, since `script-src` has no `unsafe-inline`. The theme stamp silently
 * never ran.
 *
 * Rebuilt from `request.headers` at each call site rather than hoisted, because
 * `request.cookies.set()` mutates the underlying `cookie` header and the Supabase
 * refresh path needs the updated value forwarded.
 */
function forwardedHeaders(request: NextRequest, nonce: string): Headers {
  const headers = new Headers(request.headers);
  headers.set(NONCE_HEADER, nonce);
  return headers;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

  // Static assets: no session work, no headers worth the CPU.
  if (isUnguarded(pathname)) return NextResponse.next();

  const nonce = generateNonce();

  /**
   * The response object must be created *before* the Supabase client, and the
   * client must be given a reference to it.
   *
   * `@supabase/ssr` writes refreshed tokens by calling `setAll`, which mutates
   * cookies on this response. Creating a fresh `NextResponse` afterwards — the
   * intuitive thing to do — silently discards the refreshed session, and the
   * symptom is a user signed out every hour with no error anywhere.
   */
  let response = NextResponse.next({
    request: { headers: forwardedHeaders(request, nonce) },
  });

  const supabase = createServerClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookieOptions: SESSION_COOKIE_OPTIONS,
      cookies: {
        getAll: () => request.cookies.getAll().map((c) => ({ name: c.name, value: c.value })),
        setAll: (cookiesToSet) => {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          // Rebuilt from the now-mutated request, so the refreshed `cookie`
          // header *and* the nonce both survive this second construction.
          response = NextResponse.next({
            request: { headers: forwardedHeaders(request, nonce) },
          });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  /* --- 1. Refresh ---------------------------------------------------- */

  /**
   * `getUser()` verifies the JWT with the auth server; `getSession()` merely
   * decodes the cookie. On a trust boundary that difference is the entire
   * point — and the call has the side effect of refreshing an expiring token,
   * which is what keeps §5.4's thirty-day sliding session sliding.
   */
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const hasSession = user !== null;

  /* --- 2. Guard ------------------------------------------------------ */

  const isPublic = isPublicRoute(pathname);

  if (pathname === '/') {
    // No landing page distinct from Today (§3.2: "a separate landing page is a
    // page whose question is 'where do I go?', which P8 forbids answering with
    // navigation").
    const target = hasSession ? DEFAULT_AUTHENTICATED_PATH : SIGN_IN_PATH;
    return withSecurity(NextResponse.redirect(new URL(target, request.url)), nonce, response);
  }

  if (!hasSession && !isPublic) {
    if (isApiRoute(pathname)) {
      // An API route gets a status, not a redirect. A fetch that follows a 307
      // to an HTML sign-in page produces a JSON parse error three layers away
      // from the actual cause.
      return withSecurity(
        NextResponse.json(
          {
            error: {
              code: 'unauthenticated_no_session',
              message: 'Authentication required.',
              traceId: request.headers.get('x-vercel-id') ?? 'local',
            },
          },
          { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="naitikos"' } },
        ),
        nonce,
        response,
      );
    }

    return withSecurity(
      NextResponse.redirect(new URL(signInUrlFor(pathname, search), request.url)),
      nonce,
      response,
    );
  }

  if (hasSession && pathname.startsWith(SIGN_IN_PATH)) {
    // Already signed in: bounce off the sign-in page rather than rendering a
    // form that will fail confusingly.
    return withSecurity(
      NextResponse.redirect(new URL(DEFAULT_AUTHENTICATED_PATH, request.url)),
      nonce,
      response,
    );
  }

  /* --- 3. CSRF seed --------------------------------------------------- */

  if (request.cookies.get(CSRF_COOKIE_OPTIONS.name) === undefined) {
    response.cookies.set(CSRF_COOKIE_OPTIONS.name, generateCsrfToken(), {
      httpOnly: CSRF_COOKIE_OPTIONS.httpOnly,
      sameSite: CSRF_COOKIE_OPTIONS.sameSite,
      // Same reasoning as the session cookie: browsers reject `Secure` over
      // plain http, which would break local development entirely.
      secure: !isDevelopment(),
      path: CSRF_COOKIE_OPTIONS.path,
      maxAge: CSRF_COOKIE_OPTIONS.maxAge,
    });
  }

  /* --- 4. Headers ----------------------------------------------------- */

  // The nonce reached the render layer on the *request* headers, set by
  // `forwardedHeaders` above — that is what `headers()` reads in a Server
  // Component. Nothing to set here.
  return withSecurity(response, nonce, response);
}

/**
 * Attach security headers, carrying over any cookies already set.
 *
 * The `carrier` argument exists because of the refresh trap described above: a
 * redirect built with `NextResponse.redirect` is a *different* response from
 * the one Supabase wrote refreshed cookies onto. Copying them across is what
 * stops a redirect silently signing the user out.
 */
function withSecurity(
  target: NextResponse,
  nonce: string,
  carrier?: NextResponse,
): NextResponse {
  if (carrier !== undefined && carrier !== target) {
    for (const cookie of carrier.cookies.getAll()) {
      target.cookies.set(cookie);
    }
  }

  const headers = buildSecurityHeaders({
    nonce,
    // The only cross-origin destination this app may reach (§5.14: "Explicit
    // allowlist for the model API endpoint and nothing else").
    connectSources: [clientEnv.NEXT_PUBLIC_SUPABASE_URL],
    development: isDevelopment(),
  });

  for (const [name, value] of Object.entries(headers)) {
    target.headers.set(name, value);
  }

  return target;
}

export const config = {
  /**
   * Everything except static assets.
   *
   * Written as a negative lookahead rather than a list of protected prefixes,
   * because a positive list means a new route is unprotected until someone
   * remembers to add it. This way a new route is covered the moment it exists.
   */
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icons/|sw\\.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)',
  ],
};

export { NONCE_HEADER };
