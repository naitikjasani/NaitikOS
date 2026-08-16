/**
 * Tooth notation — §4.5's "per-tooth procedure history using standard
 * notation".
 *
 * ## Which standard, and how that was decided
 *
 * The blueprint says "standard notation" and does not name one. There are three
 * in use — FDI two-digit, Universal (1–32), and Palmer — and they disagree
 * about the same tooth, so picking wrongly means a decade of records that a
 * dentist reads as a different tooth.
 *
 * §9.2 settles it by example rather than by rule: *"`procedure` — what was
 * done. **Root canal on tooth 36**, 2024-03."* Tooth 36 is FDI. It is also the
 * notation used by every dental practice outside North America, which is where
 * this record will be read, and `procedure.toothNotation` is already a `text`
 * column with an index — so this is a decision about interpretation, not about
 * storage.
 *
 * ## Two digits, and what each one means
 *
 * ```
 *        UPPER
 *   18…11 | 21…28      quadrant 1 = upper right, 2 = upper left
 *   ------+------      (the patient's right and left, not the viewer's)
 *   48…41 | 31…38      quadrant 4 = lower right, 3 = lower left
 *        LOWER
 * ```
 *
 * First digit is the quadrant, second is the position counting outward from the
 * midline: 1 central incisor … 8 third molar. So 36 is quadrant 3, position 6 —
 * the lower-left first molar, exactly as §9.2 says.
 *
 * Quadrants 5–8 are the primary dentition. They are parsed and labelled because
 * a childhood record could legitimately arrive in a scanned document, and
 * refusing to read one would silently drop it.
 *
 * ## The chart is a layout, not a diagnosis
 *
 * {@link ARCHES} exists so the screen can draw the mouth in the order a dentist
 * expects. Nothing in this file knows what a procedure *means*, scores a tooth's
 * condition, or infers anything from a pattern of work. P5, and the specific
 * failure it prevents: a per-tooth "health score" computed from procedure counts
 * would tell a person with four root canals that their mouth is failing, which
 * is a clinical judgement made by arithmetic.
 */

/** `11`–`48` permanent, `51`–`85` primary. */
export type ToothNotation = string;

export type Quadrant = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type ToothPosition = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type Tooth = {
  readonly notation: ToothNotation;
  readonly quadrant: Quadrant;
  readonly position: ToothPosition;
  readonly arch: 'upper' | 'lower';
  /** The patient's side, which is the side a dental chart is drawn from. */
  readonly side: 'right' | 'left';
  readonly isPrimary: boolean;
  /** `lower-left first molar`. */
  readonly label: string;
};

const QUADRANTS: Readonly<
  Record<Quadrant, { readonly arch: 'upper' | 'lower'; readonly side: 'right' | 'left'; readonly isPrimary: boolean }>
> = Object.freeze({
  1: { arch: 'upper', side: 'right', isPrimary: false },
  2: { arch: 'upper', side: 'left', isPrimary: false },
  3: { arch: 'lower', side: 'left', isPrimary: false },
  4: { arch: 'lower', side: 'right', isPrimary: false },
  5: { arch: 'upper', side: 'right', isPrimary: true },
  6: { arch: 'upper', side: 'left', isPrimary: true },
  7: { arch: 'lower', side: 'left', isPrimary: true },
  8: { arch: 'lower', side: 'right', isPrimary: true },
});

/**
 * Position names, permanent dentition.
 *
 * Positions 4, 5 and 8 do not exist in the primary dentition — a child has five
 * teeth per quadrant, not eight — so {@link parseTooth} rejects `54`, `55` and
 * `58` rather than labelling a tooth nobody has.
 */
const PERMANENT_POSITIONS: Readonly<Record<ToothPosition, string>> = Object.freeze({
  1: 'central incisor',
  2: 'lateral incisor',
  3: 'canine',
  4: 'first premolar',
  5: 'second premolar',
  6: 'first molar',
  7: 'second molar',
  8: 'third molar',
});

const PRIMARY_POSITIONS: Readonly<Partial<Record<ToothPosition, string>>> = Object.freeze({
  1: 'central incisor',
  2: 'lateral incisor',
  3: 'canine',
  4: 'first molar',
  5: 'second molar',
});

/**
 * Parse an FDI notation, or `null`.
 *
 * `null` rather than a partial reading. A tooth number that does not resolve is
 * displayed verbatim — the record keeps what was written — and gets no place on
 * the chart, which is visibly different from being placed on the wrong one.
 */
export function parseTooth(notation: string): Tooth | null {
  const trimmed = notation.trim();
  if (!/^[1-8][1-8]$/u.test(trimmed)) return null;

  const quadrant = Number(trimmed[0]) as Quadrant;
  const position = Number(trimmed[1]) as ToothPosition;
  const meta = QUADRANTS[quadrant];

  const name = meta.isPrimary ? PRIMARY_POSITIONS[position] : PERMANENT_POSITIONS[position];
  /* A primary quadrant with position 6, 7 or 8 is not a tooth. */
  if (name === undefined) return null;

  return {
    notation: trimmed,
    quadrant,
    position,
    arch: meta.arch,
    side: meta.side,
    isPrimary: meta.isPrimary,
    label: `${meta.arch}-${meta.side} ${name}${meta.isPrimary ? ' (primary)' : ''}`,
  };
}

/** `lower-left first molar`, or the raw string when it does not parse. */
export function toothLabel(notation: string): string {
  return parseTooth(notation)?.label ?? notation;
}

/**
 * The permanent dentition, laid out as a chart is drawn.
 *
 * Upper row left-to-right on the page is the patient's right quadrant reversed
 * then their left quadrant forward — which is how a dentist reads a chart, and
 * getting it backwards would put every marked tooth on the wrong side of the
 * mouth.
 */
export const ARCHES: Readonly<{ readonly upper: readonly string[]; readonly lower: readonly string[] }> =
  Object.freeze({
    upper: Object.freeze([
      ...[8, 7, 6, 5, 4, 3, 2, 1].map((position) => `1${String(position)}`),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((position) => `2${String(position)}`),
    ]),
    lower: Object.freeze([
      ...[8, 7, 6, 5, 4, 3, 2, 1].map((position) => `4${String(position)}`),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((position) => `3${String(position)}`),
    ]),
  });

/* -------------------------------------------------------------------------
 * Procedures
 * ---------------------------------------------------------------------- */

export type DentalProcedure = {
  readonly id: string;
  readonly medicalEventId: string;
  readonly name: string;
  readonly code: string | null;
  readonly performedBy: string | null;
  readonly location: string | null;
  readonly toothNotation: string | null;
  readonly bodySite: string | null;
  readonly performedAt: string | null;
  readonly outcome: string | null;
  readonly complications: string | null;
  /** Minor units — paise, cents. §4.5 links this to Money in V3. */
  readonly costMinor: number | null;
  readonly currency: string | null;
};

export type ProcedureInput = {
  readonly id: string;
  readonly name: string;
  readonly toothNotation?: string | null;
  readonly performedBy?: string | null;
  readonly location?: string | null;
  readonly performedAt: string;
  readonly zone: string;
  readonly outcome?: string | null;
  readonly complications?: string | null;
  readonly costMinor?: number | null;
  readonly currency?: string | null;
};

/**
 * Procedures grouped by tooth, most recent first within each.
 *
 * The question §4.5 exists to answer — *"what has been done to my teeth"* — is
 * per tooth, and a flat chronological list does not answer it. A tooth with
 * three procedures over eight years is the record no dental practice retains
 * "across relocations, insurers, or practitioner changes".
 *
 * Procedures with no tooth (a scale and polish, an extraction site graft) are
 * returned under the empty key rather than dropped, because they are still part
 * of the history.
 */
export function byTooth(
  procedures: readonly DentalProcedure[],
): ReadonlyMap<string, readonly DentalProcedure[]> {
  const grouped = new Map<string, DentalProcedure[]>();

  for (const procedure of procedures) {
    const key = procedure.toothNotation ?? '';
    const bucket = grouped.get(key);
    if (bucket === undefined) grouped.set(key, [procedure]);
    else bucket.push(procedure);
  }

  for (const bucket of grouped.values()) {
    bucket.sort((a, b) => ((a.performedAt ?? '') < (b.performedAt ?? '') ? 1 : -1));
  }

  return grouped;
}

/** Total cost across procedures sharing a currency, in minor units. */
export function totalCost(
  procedures: readonly DentalProcedure[],
): readonly { readonly currency: string; readonly minor: number }[] {
  const totals = new Map<string, number>();

  for (const procedure of procedures) {
    if (procedure.costMinor === null || procedure.currency === null) continue;
    /*
     * Grouped by currency and never summed across them. There is no exchange
     * rate in this system and inventing one would produce a number that is
     * wrong by a different amount every year — §6.2's unit argument applied to
     * money.
     */
    totals.set(procedure.currency, (totals.get(procedure.currency) ?? 0) + procedure.costMinor);
  }

  return [...totals.entries()].map(([currency, minor]) => ({ currency, minor }));
}
