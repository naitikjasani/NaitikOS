import type { NextConfig } from 'next';

/**
 * Next configuration.
 *
 * Security headers are NOT set here. They are set in `middleware.ts`, because
 * the CSP is nonce-based (§5.14) and a nonce must be generated per request —
 * static headers in this file cannot do that. Putting a second, weaker CSP here
 * would silently override the real one on some routes.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * Packages consumed as source (docs/adr/0003), so Next must transpile them
   * rather than expect prebuilt output.
   */
  transpilePackages: ['@naitikos/core', '@naitikos/db', '@naitikos/api', '@naitikos/shared'],

  /**
   * §5.6: "Next.js route caching is disabled for all personal data. Every data
   * route is dynamic. Serving one user's stale data to that same user is a
   * correctness bug in a system whose entire premise is an accurate record."
   */
  experimental: {
    staleTimes: { dynamic: 0, static: 0 },
  },

  /** §5.14 — do not advertise the framework. */
  poweredByHeader: false,

  typescript: {
    // CI runs `turbo run typecheck` separately; failing the build here too
    // means a type error cannot reach production through any path.
    ignoreBuildErrors: false,
  },

  // Note: Next 16 removed the `eslint` config key. Linting is a separate
  // pipeline step (`turbo run lint`), which is where §11.5 puts it anyway.
};

export default nextConfig;
