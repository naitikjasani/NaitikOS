/**
 * Cookie transport policy — the one place that decides whether a cookie this
 * application sets carries `Secure`.
 *
 * ## The attack `Secure` prevents, and why the predicate is not `NODE_ENV`
 *
 * Without `Secure`, a browser attaches the cookie to a plaintext request. Anyone
 * on the path — a café access point, a hotel router, a compromised ISP box —
 * reads it, and for this application that path carries traffic to a database of
 * psychiatric medication history and body photographs (§4.7). `Secure` is what
 * keeps that cookie off the wire in the clear, and nothing here may weaken it.
 *
 * What decides whether a cookie *can* be carried is the **scheme of the
 * connection**, which `NODE_ENV` does not describe. `NODE_ENV` describes a
 * build. A production build served over `http://localhost` — which is exactly
 * what `next build && next start` does, and exactly how one reproduces a
 * production-only defect — is a production `NODE_ENV` on a plaintext
 * connection. The browser then drops every `Secure` cookie it is offered, the
 * CSRF cookie among them, and `verifyCsrf` fails its double-submit check on
 * every mutation. Every POST answers 403 and nothing says why.
 *
 * ## Why the scheme is read from `NEXT_PUBLIC_SITE_URL`
 *
 * Because it is the only statement of this deployment's own origin that an
 * attacker has no hand in. The alternatives were both considered and both are
 * the same mistake in new clothes:
 *
 *   - **The `Host` header.** `lib/env.ts` already refuses it for the CSRF
 *     expected origin — "an attacker controls Host, and checking against it
 *     would not be a check". Deriving cookie transport from it is that sentence
 *     again with a different consequence.
 *   - **`x-forwarded-proto`.** It is a request header. On Vercel the platform
 *     edge overwrites whatever the client sent, so trusting it *there* happens
 *     to be sound — but that is a property of one host's ingress, not of this
 *     code, and the day this runs behind a proxy that forwards the client's
 *     value, `x-forwarded-proto: http` from an attacker strips `Secure` from
 *     the cookie the next plaintext request will carry. A control whose
 *     correctness depends on an unwritten deployment assumption is a control
 *     that breaks silently during a migration.
 *
 * `NEXT_PUBLIC_SITE_URL` costs nothing to trust because it is **already
 * load-bearing and already verified against the browser**. `csrfGuard` compares
 * it to the `Origin` header, which the browser attaches and page script cannot
 * forge, and an `Origin` comparison is a comparison of scheme, host and port
 * together. So a deployment whose configured scheme disagrees with the scheme
 * the browser is actually using cannot complete a single mutation — the origin
 * check rejects it first. By the time this predicate matters, the scheme it
 * reads has been corroborated by an unforgeable header.
 *
 * ## Fail closed: only a loopback origin may omit `Secure`
 *
 * The predicate is not "is the scheme http". It is "is the scheme http **and**
 * is the host the loopback interface". Every other input — an `http://` public
 * host, an unparseable value, a LAN address — yields `Secure`.
 *
 * That asymmetry is the point. A deployment misconfigured to `http://naitikos.app`
 * gets a cookie the browser refuses to store, which is a loud, immediate,
 * total failure; the same misconfiguration under a bare scheme check would get
 * a working application quietly shipping its CSRF token over plaintext. Of the
 * two ways to be wrong, only one is recoverable, and it is the noisy one.
 *
 * The LAN case is worth naming because it is the one a developer will meet: a
 * phone on the same Wi-Fi loading `http://192.168.1.20:3000` to test the PWA
 * gets `Secure` and therefore gets no cookie. That is correct and not a bug to
 * route around — a private network is still a plaintext broadcast medium with
 * other people's devices on it. Test over a tunnel that terminates TLS.
 *
 * ## What was checked about browsers, rather than assumed
 *
 * `http://localhost` is a *secure context* under the Secure Contexts spec, and
 * it is tempting to conclude from that that a `Secure` cookie would be accepted
 * there and no predicate is needed at all. Secure Contexts and the cookie
 * `Secure` attribute are separate mechanisms, and they disagree:
 *
 *   - **Firefox** accepts it, since Firefox 75 — Bugzilla 1618113, fixed by
 *     switching the check from an https-scheme test to
 *     `IsPotentiallyTrustworthyOrigin()`.
 *   - **Chrome** accepts it.
 *   - **Safari rejects it.** Documented in httpwg/http-extensions issue 2605,
 *     which exists precisely because the three disagree; WebKit requires real
 *     https regardless of host.
 *
 * MDN states the exception unconditionally — "the `https:` requirements are
 * ignored when the `Secure` attribute is set by localhost" — which is true of
 * two engines out of three. Relying on it would leave local development broken
 * on Safari only, and "works for me" across a browser split is a worse bug to
 * own than the one this file fixes. Hence: omit the attribute, do not rely on
 * the exception.
 */

import { CSRF_COOKIE_OPTIONS } from '@naitikos/api';

/**
 * `127.0.0.0/8`, in full — the whole block answers on the loopback interface,
 * and `127.0.0.1` is merely its most-typed member. Octet ranges are spelled out
 * rather than `\d{1,3}` so that `127.0.0.999` is not mistaken for an address.
 */
const LOOPBACK_IPV4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * Does this hostname name the local machine's loopback interface?
 *
 * The membership test is exact, never a substring. `localhost.evil.example.com`
 * is a hostname an attacker can register and serve over plaintext, and a
 * `includes('localhost')` here would hand them a cookie with no `Secure`
 * attribute — the lookalike-origin bug, relocated from the origin check into
 * the cookie policy.
 *
 * `.localhost` subdomains are included on the strength of RFC 6761, which
 * reserves the whole label for loopback; `[::1]` appears in bracketed form
 * because that is what `URL.hostname` yields for an IPv6 literal.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (host === 'localhost') return true;
  if (host.endsWith('.localhost') && host.length > '.localhost'.length) return true;
  if (host === '[::1]' || host === '::1') return true;

  return LOOPBACK_IPV4.test(host);
}

/**
 * Must cookies set by this deployment carry `Secure`?
 *
 * @param siteUrl - the deployment's own origin, from validated configuration.
 *   `lib/env.ts` guarantees it parses as a full URL; the `catch` below is a
 *   second lock on the same door, because the consequence of the guarantee ever
 *   lapsing is a cookie on the wire in cleartext.
 *
 * @returns `false` only for an explicitly configured plaintext loopback origin.
 *   Everything else — including every input this function does not recognise —
 *   is `true`.
 */
export function requiresSecureCookies(siteUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(siteUrl);
  } catch {
    return true;
  }

  // https, and anything else a future deployment might serve, keeps `Secure`.
  // Only plaintext is a candidate for omitting it.
  if (url.protocol !== 'http:') return true;

  return !isLoopbackHost(url.hostname);
}

/**
 * The attributes the CSRF cookie is written with.
 *
 * A function rather than a constant so the transport decision is made from
 * configuration at the call site, and so it is reachable by a test without a
 * `NextRequest` (§11.2: the rule a security control encodes should be testable
 * without the framework it happens to run inside).
 *
 * **`httpOnly` is false, and that is required rather than overlooked.** This is
 * the question a future reader gets wrong, so it is answered in two places —
 * see also `CSRF_COOKIE_OPTIONS` in `packages/api`. Double-submit works by
 * having page script read the cookie and echo it in a header; an httpOnly
 * cookie cannot be read and the scheme stops functioning. It is safe because
 * the token is not a credential — knowing it grants nothing, and the property
 * the defence rests on is that a *cross-origin* attacker cannot read it, which
 * the same-origin policy provides whatever `httpOnly` says. The session cookie,
 * which is a credential, is httpOnly and set elsewhere.
 */
export function csrfCookieAttributes(siteUrl: string): {
  readonly httpOnly: boolean;
  readonly sameSite: typeof CSRF_COOKIE_OPTIONS.sameSite;
  readonly secure: boolean;
  readonly path: string;
  readonly maxAge: number;
} {
  return {
    httpOnly: CSRF_COOKIE_OPTIONS.httpOnly,
    sameSite: CSRF_COOKIE_OPTIONS.sameSite,
    secure: requiresSecureCookies(siteUrl),
    path: CSRF_COOKIE_OPTIONS.path,
    maxAge: CSRF_COOKIE_OPTIONS.maxAge,
  };
}
