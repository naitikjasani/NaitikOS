# core/export

The export format (§9.10) — the P2 obligation.

**Owns:** a minimal store-only ZIP writer with CRC-32, and the bundle assembly — NDJSON per table, a generated `schema.json`, the metric registry, a README written for a stranger, and the decryption utility.

**No IO.** The caller supplies rows; this produces bytes. That is what makes the format testable without a database, and it is what makes §9.10's quarterly drill possible at all — "asserts row-count and checksum equality" needs the archive to be a pure function of its input.

Two properties are structural rather than aspirational:

1. **Self-describing.** `schema.json` is generated from the same `MetricDefinition` values the application validates against, so it cannot drift. The metric registry travels inside the archive: a bare `74.2` is nothing, joined to its metric row it is a complete fact.
2. **Decryptable without this application.** `decrypt.md` ships as readable source naming the algorithm and its parameters — a binary is exactly the thing that stops running.

Blueprint §9.10, §2.1, §5.4. Prose: [docs/export.md](../../../../docs/export.md).
