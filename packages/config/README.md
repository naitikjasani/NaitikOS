# @naitikos/config

Shared build, lint, and test configuration.

## What this package owns

Every piece of configuration that more than one workspace package needs. Blueprint §6.2:

> Exists so that "core may not import React" is written once, as a lint rule, and enforced everywhere automatically. Configuration duplicated across packages drifts; configuration in a package does not.

| Path | Purpose |
| --- | --- |
| `tsconfig/base.json` | Strictness baseline. `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`. |
| `tsconfig/library.json` | Non-React packages. |
| `tsconfig/nextjs.json` | The web application. |
| `eslint/base.js` | TypeScript baseline + the raw-`Date` ban (§5.3, §11.3). |
| `eslint/boundaries.js` | ★ The §5.0 layering rule, as a build error. |
| `eslint/library.js` | Non-React packages + `no-bare-quantity`. |
| `eslint/react.js` | React surfaces + the Zustand-scope rule (§5.1). |
| `eslint/rules/` | The two custom rules from §11.3. |
| `vitest/base.js` | Coverage floor (§11.4). |

## What it does not own

Runtime code of any kind. Nothing here is imported by the application at runtime.

## The custom rules

Blueprint §11.3 specifies two project-specific rules. Both are heuristics — they cannot see types — and both are scoped narrowly for that reason. A rule that fires falsely gets disabled, and a disabled rule takes its true positives with it.

**`@naitikos/no-bare-quantity`** — a measured value assigned a bare number. Applied only in `core`, `db`, `api`, where measured values live. Rationale in §6.2: "Unit confusion in a medical record is a real, documented category of harm."

**`@naitikos/no-sensitive-log`** — bans `console.*` outright (§5.13 requires structured logging with a `traceId`) and flags sensitive-looking identifiers passed to a logger. The primary defence is the `Sensitive<T>` type in `@naitikos/shared`, which makes leakage a compile error; this rule catches the value on its way to the logger *before* it has been wrapped.

## Changing a rule

Rules here are load-bearing. Weakening one is an architectural decision, not a lint tweak — record it as an ADR in `docs/adr/` (§11.6) before merging.
