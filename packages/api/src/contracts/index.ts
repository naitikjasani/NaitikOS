/** Zod contracts — imported by both client and server (§6.2). */
export * from './auth';

/** Events, timeline, media, and background jobs (ADR 0005). */
export * from './timeline';

/** The observation substrate and the Daily Close (§9.2, §4.0). */
export * from './observations';

/** Gym — sessions, sets, exercises, volume (§4.1). */
export * from './gym';

/** Mind — episodes, journal, practices, medication adherence (§4.7). */
export * from './mind';

/** Skin, the routine engine, and the capture protocol (§4.2, §9.2, §9.8). */
export * from './skin';

/** Telemetry — §5.11's names-and-numbers-only contract. */
export * from './telemetry';

/** The authoring contracts — §2.1's "no manual database intervention". */
export * from './registers';

/** Health core — vitals, labs, conditions, symptoms, appointments (§4.4). */
export * from './health';

/** The document vault and its extraction pipeline (§4.11, §9.9). */
export * from './documents';

/** Goals — declarations and targets. Never progress (§4.10). */
export * from './goals';

/** Nutrition — meals, foods, templates, targets (§4.3). */
export * from './nutrition';

/** Work — projects, tasks, and the career log (§4.8). */
export * from './work';

/** Learning, the calendar import, and focus sessions (§4.8). */
export * from './learning';

/** Sleep — nights, timing, and disturbances (§4.6). */
export * from './sleep';

/** Reviews — weekly, monthly, quarterly, annual (§4.12). */
export * from './reviews';

/** Money — accounts, transactions, budgets, subscriptions, shopping (§4.9). */
export * from './money';

/** The Life Timeline — eras, chapters and significant events (§10.8). */
export * from './life';

/** Wearable ingestion — Apple Health and Google Fit batches (§2.3, §9.7). */
export * from './samples';
