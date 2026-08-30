import { baseTestConfig } from '@naitikos/config/vitest/base';
import { defineConfig } from 'vitest/config';

/**
 * No raised coverage threshold here yet, and the reason is stated rather than
 * left as an oversight.
 *
 * §11.4 puts the high bar on `packages/core` because it is the durable layer.
 * This package is explicitly the *replaceable* one (§5.0) — it wraps a model
 * API that will change. What matters here is that the guardrails are covered,
 * and they are: `schemas/` and `guardrails/` are the two directories where an
 * untested branch is a safety hole rather than a missing test.
 */
export default defineConfig(baseTestConfig);
