/**
 * Security headers — §5.14.
 *
 *   "**Transport:** TLS everywhere, HSTS with preload.
 *    **CSP:** strict, nonce-based, `default-src 'self'`, no `unsafe-inline`,
 *    no `unsafe-eval`. Explicit allowlist for the model API endpoint and
 *    nothing else."
 *
 * The CSP is the one that earns its keep. §5.14's first named adversary is "a
 * compromised third-party dependency exfiltrating data", and a strict
 * `connect-src` is what turns that from a data breach into a blocked request in
 * a console nobody reads. On a database of psychiatric history and body
 * photographs, that difference is the whole control.
 */

export type SecurityHeaderOptions = {
  /**
   * Per-request nonce for inline scripts.
   *
   * Must be cryptographically random and must never be reused across responses
   * — a predictable or shared nonce is exactly equivalent to `unsafe-inline`,
   * and it looks secure while being nothing of the sort.
   */
  readonly nonce: string;
  /** Origins the app may talk to beyond itself — the Supabase project URL. */
  readonly connectSources?: readonly string[];
  /**
   * Relax for local development.
   *
   * Next's dev server needs `unsafe-eval` for React Refresh and a websocket for
   * HMR. Gated on an explicit flag rather than `NODE_ENV` so it cannot be
   * enabled by an environment variable being unset.
   */
  readonly development?: boolean;
};

/** Two years, the minimum for the HSTS preload list. */
const HSTS_MAX_AGE_SECONDS = 63_072_000;

/**
 * Build the Content-Security-Policy.
 *
 * Each directive below is doing work; none is boilerplate.
 */
export function buildContentSecurityPolicy(options: SecurityHeaderOptions): string {
  const { nonce, connectSources = [], development = false } = options;

  const connect = ["'self'", ...connectSources];
  if (development) {
    // HMR websocket. Not present in production builds.
    connect.push('ws://localhost:*', 'http://localhost:*');
  }

  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    /**
     * `strict-dynamic` lets a nonce-approved script load its own chunks, which
     * Next's runtime requires. It also causes modern browsers to *ignore* the
     * host allowlist in `script-src` — which is the point: an allowlist is a
     * weak control that a single permissive CDN entry defeats, and the nonce is
     * the real one.
     */
    "'strict-dynamic'",
  ];

  // React Refresh evaluates code. Development only, and never in a build that
  // touches real data (§5.15: preview and local run on synthetic data only).
  if (development) scriptSrc.push("'unsafe-eval'");

  const directives: readonly string[] = [
    `default-src 'self'`,
    `script-src ${scriptSrc.join(' ')}`,
    /**
     * `unsafe-inline` for styles, and this is a genuine compromise rather than
     * an oversight.
     *
     * Tailwind v4 and Next both emit inline `<style>` blocks during hydration,
     * and nonce-ing every one of them is not currently possible without
     * patching the framework. The residual risk is CSS injection — defacement
     * and, with sufficient creativity, selector-based data inference. Neither
     * is exfiltration, because `connect-src` still holds.
     *
     * Recorded in docs/auth.md as accepted debt with a revisit condition.
     */
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    // The exfiltration control. Nothing may be sent anywhere not listed.
    `connect-src ${connect.join(' ')}`,
    // No Flash, no Java, no plugin content of any kind.
    `object-src 'none'`,
    // Stops a `<base>` tag rewriting every relative URL in the document.
    `base-uri 'self'`,
    // Where forms may POST. Blocks a script retargeting a form off-origin.
    `form-action 'self'`,
    // Clickjacking. Modern replacement for X-Frame-Options.
    `frame-ancestors 'none'`,
    // Nothing may be embedded.
    `frame-src 'none'`,
    // Upgrade any stray http:// subresource rather than failing it.
    `upgrade-insecure-requests`,
  ];

  return directives.join('; ');
}

/**
 * The full header set.
 *
 * Applied to every response including static assets, because a header that is
 * conditional is a header that will be missing on the one route that needed it.
 */
export function buildSecurityHeaders(
  options: SecurityHeaderOptions,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': buildContentSecurityPolicy(options),

    /** MIME sniffing. Stops an uploaded file being reinterpreted as script. */
    'X-Content-Type-Options': 'nosniff',

    /**
     * Referrer policy.
     *
     * `same-origin` rather than the more common
     * `strict-origin-when-cross-origin`, because this application's *paths* are
     * sensitive: `/body/skin/treatments` in a Referer header tells a third
     * party something real about the user. Cross-origin requests send no
     * referrer at all.
     */
    'Referrer-Policy': 'same-origin',

    /**
     * Deny the device APIs this application does not use.
     *
     * `camera` is deliberately *not* denied — §4.2's photography protocol needs
     * it. Everything else is off, so a compromised dependency cannot quietly
     * open a microphone in a health app.
     */
    'Permissions-Policy': [
      'accelerometer=()',
      'autoplay=()',
      'browsing-topics=()',
      'camera=(self)',
      'display-capture=()',
      'encrypted-media=()',
      'geolocation=()',
      'gyroscope=()',
      'idle-detection=()',
      'interest-cohort=()',
      'magnetometer=()',
      'microphone=()',
      'midi=()',
      'payment=()',
      'usb=()',
    ].join(', '),

    /** Legacy clickjacking defence, for browsers predating frame-ancestors. */
    'X-Frame-Options': 'DENY',

    /**
     * Cross-origin isolation.
     *
     * `same-origin` on the opener policy severs `window.opener`, so a page
     * opened from here cannot navigate this one. The resource policy stops
     * other sites embedding our responses.
     */
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };

  if (options.development !== true) {
    // HSTS only over TLS. Sending it in development would poison localhost in
    // the browser's HSTS store and force https:// on every other local project.
    headers['Strict-Transport-Security'] =
      `max-age=${String(HSTS_MAX_AGE_SECONDS)}; includeSubDomains; preload`;
  }

  return Object.freeze(headers);
}

/**
 * Generate a CSP nonce.
 *
 * 128 bits from the platform CSPRNG, base64. `Math.random` would be
 * catastrophic here and is the obvious wrong thing to reach for, so the correct
 * call is wrapped rather than left to a call site.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
