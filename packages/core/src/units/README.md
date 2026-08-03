# core/units

The unit system. `Quantity`, not bare numbers.

**Owns:** `Quantity { value: Decimal, unit: Unit }`, the unit registry, and total, tested conversions — kg/lb, mg/mcg, mmol/mg-dL.

**Why this exists at all:** blueprint §6.2 is blunt — "Unit confusion in a medical record is a real, documented category of harm. Every measured quantity is a `Quantity`, never a bare number, and conversion is total and tested. There is no path by which milligrams become micrograms."

The `@naitikos/no-bare-quantity` lint rule (§11.3) enforces this from the outside; this package is what makes complying with it possible.

Held to the 95% coverage bar (§11.4).

Blueprint §6.2, §9.2, §11.3.
