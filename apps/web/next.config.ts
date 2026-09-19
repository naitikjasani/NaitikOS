import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

// Next runs from apps/web in this workspace, while v0 injects project
// variables at the repository root. Load that environment before the config
// and middleware bundles are evaluated.
loadEnvConfig(path.resolve(process.cwd(), '../..'), process.env.NODE_ENV !== 'production');

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
  transpilePackages: [
    '@naitikos/core',
    '@naitikos/db',
    '@naitikos/api',
    '@naitikos/shared',
    '@naitikos/design-system',
  ],

  /**
   * §5.6: "Next.js route caching is disabled for all personal data. Every data
   * route is dynamic. Serving one user's stale data to that same user is a
   * correctness bug in a system whose entire premise is an accurate record."
   *
   * Only `dynamic` is set. Next rejects `static` below 30 seconds, and it does
   * not matter here: every route in this application is `force-dynamic`, so
   * nothing is classified static in the first place. Setting it to 0 was
   * invalid config that Next warned about and ignored — the caching guarantee
   * comes from the route segment config, not from this line.
   */
  experimental: {
    staleTimes: { dynamic: 0 },
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
