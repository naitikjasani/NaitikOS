# core/errors

The closed `DomainError` union.

**Owns:** four variants — `validation`, `not_found`, `conflict`, `precondition_failed` — with structured fields, plus their constructors and guards.

**Closed means closed.** Adding a fifth variant requires an ADR (§11.6). Every exhaustive switch guarded by `assertNever` will fail to compile until the HTTP mapping in `packages/api/errors` is updated — that compile error is the point.

Errors are plain data, not `Error` subclasses: they cross the wire, land in the audit log (§9.4), and get pattern-matched. A stack trace helps with none of that.

Blueprint §5.12.
