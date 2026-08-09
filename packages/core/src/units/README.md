# core/units

The unit system. `Quantity`, not bare numbers.

**Owns:** `Decimal` (exact decimal arithmetic on `bigint`), `Quantity { value, unit }`, the unit registry with its dimensions, and total, tested conversions — kg/lb, mg/mcg, °C/°F, and the analyte-aware mmol/mg-dL case.

**Why this exists at all:** blueprint §6.2 is blunt — "Unit confusion in a medical record is a real, documented category of harm. Every measured quantity is a `Quantity`, never a bare number, and conversion is total and tested. There is no path by which milligrams become micrograms."

Three properties make that true rather than aspirational, and all three are needed:

1. **Every unit carries a dimension.** `convertQuantity` returns `null` across dimensions rather than guessing, so `kg → hours` is a handled absence and not a plausible-looking number.
2. **Every factor is an exact ratio.** `°F → °C` is `× 5 ÷ 9`, so `212 °F` is exactly `100 °C` rather than `100.0000000094`.
3. **Molar and mass concentration are separate dimensions.** The conversion between mmol/L and mg/dL depends on the analyte's molar mass, so there is no substance-independent factor to register. `convertConcentration` takes an analyte and refuses one it does not know.

`Decimal` is `{ unscaled: bigint, scale: number }`. Scale is significant and preserved — `1.250` and `1.25` compare equal but are not identical, because the first records a measurement to three places. A `number` anywhere on this path reintroduces the floating point §5.3 bans.

The `@naitikos/no-bare-quantity` lint rule (§11.3) enforces the outer discipline; this package is what makes complying with it possible.

Held to the 95% coverage bar (§11.4).

Blueprint §6.2, §5.3, §9.2, §11.3. Prose: [docs/observations.md](../../../../docs/observations.md).
