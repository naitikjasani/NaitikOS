# core/statistics

Correlation, changepoint detection, trend fitting, moving averages.

**Owns:** every number the user ever sees. Blueprint §10.0: "Every number the user sees came from a SQL query. Every correlation came from a statistical test in `packages/core/statistics`." A language model narrates these results; it never produces them.

**Testing:** property-based, not example-based (§11.4). Functions are tested against generated series with known properties — "a detector that finds a changepoint in pure noise is a bug that example-based tests will not catch and that would otherwise reach production as a plausible-looking insight."

Held to the 95% coverage bar (§11.4).

Blueprint §10.0, §10.6, §11.4.
