import { baseTestConfig } from '@naitikos/config/vitest/base';
import { defineConfig } from 'vitest/config';

/**
 * Contracts and guards are pure functions over plain data, so the default
 * 70% floor from the shared base (§11.4) is the right bar here — this is not
 * the durable layer, and it has no I/O to mock.
 */
export default defineConfig(baseTestConfig);
