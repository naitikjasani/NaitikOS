# core/close

The Daily Close (§4.0) — the ritual the whole product is built around.

**Owns:** `buildCloseForm` (which fields the Close has, generated from the metric registry, with §4.0's eleven-element budget as arithmetic rather than a comment) and `planDailyClose` (what a submission *means*: which answers changed, which are corrections, whether the day was already closed).

Both are pure. The repository executes the plan in one transaction; nothing here does IO. That split is what makes §4.0's rules — partial close, re-submission, unchanged answer, cleared note — testable from a literal rather than from a database.

**Not a module.** §4.0: "Not a module — the ritual that feeds all of them." The Close writes observations across Mind, Body/Sleep and Body/Skin, and reads the active medication register. It owns no domain of its own.

Blueprint §4.0, §1.5, §9.1, §9.5. Prose: [docs/daily-close.md](../../../../docs/daily-close.md).
