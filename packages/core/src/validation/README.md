# core/validation

§1.4's metrics and §12's V1 gate — the arithmetic that decides whether October
is V2 or capture friction.

**Owns:** the §1.4 table (capture latency, time in app, correction rate,
derived-fact ratio), the Daily Close funnel, the foreground-minutes
approximation, §1.5's anti-goal check, and the gate itself.

**Does not own** the telemetry that feeds it (`db/repositories/telemetry`) or the
dashboard that renders it (`web/features/validation`).

## Why the gate is a function

On 29 September the operator is also the person deciding whether to honour it,
which is the worst combination of roles. A gate evaluated by hand on the day is a
gate evaluated generously. `evaluateGate` computes, states the verdict, and names
the consequence — and it reports `unreachable` as soon as the arithmetic says so,
because learning that on the 20th is worth more than learning it on the 29th.

## Two things every metric here does

**`null`, never a passing zero.** "No captures measured" and "every capture took
0 ms" are different facts, and a dashboard reporting the second when it means the
first would show the health metric passing on the day the system stopped being
used.

**The sample size travels with the value.** A p50 over three captures is noise
wearing a statistic's clothes.

Full reasoning: [`docs/validation.md`](../../../../docs/validation.md).

Blueprint §1.4, §1.5, §5.11, §12.
