# core/temporal

Time. The only place in the codebase permitted to touch a raw `Date`.

**Owns:** the injectable `Clock`, hybrid logical clocks (§5.7), timezone-aware date arithmetic, and the bitemporal interval helpers used by `medical_event` (§9.5).

**Why it is walled off:** blueprint §5.3 requires every observation to store the IANA zone it was captured in, because "a workout at 7am during travel is a materially different fact from one at 7am at home, and discarding the zone destroys information you cannot recover." `new Date()` silently discards it, so ESLint bans it everywhere except here (§11.3).

The clock is injectable so §5.8's cases — drift, NTP correction, manual adjustment — are testable rather than hypothetical.

Blueprint §5.3, §5.7, §5.8, §9.5.
