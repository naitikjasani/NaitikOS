# The document vault

**Status:** shipped, 10 August 2026. · **Blueprint sections:** §4.11, §9.9,
§5.5, §10.0, §14.4
**Related:** [health.md](health.md)

---

## 1. The loop this exists to close

§12 asks for one thing by name:

> "Vitamin D tracking as the first end-to-end clinical loop, **from lab PDF to
> trend to consultation question**."

Four steps, with a person in the middle of them:

1. the browser reads the PDF's text layer and posts it with the document
2. the server files it, stores the text, and parses out **candidates**
3. **the operator reviews and confirms**
4. the panel, results and observations are written — and from there the trend
   and the question are ordinary reads over data that already exists

`packages/db/src/repositories/health.repository.test.ts` walks all four against
real Postgres and asserts the number in the final question is the number on the
page. That test exists because this loop crosses five layers and every one of
them looks correct in isolation.

## 2. An extraction is a proposal, never an observation

Step 3 is not a confirmation dialog and it is not skippable.

§9.1 makes observations append-only. A misread decimal point putting a vitamin D
of 142 ng/mL into the record is there for as long as the record is,
indistinguishable from a measurement. Append-only is *why* the moment to be
careful is before the write — there is no later.

So:

- Nothing enters the observation log until it is confirmed.
- A candidate the parser fully understood (name, value, unit, printed range)
  arrives **ticked**. A bare `Ferritin 45` — which might be a result or a page
  reference — arrives **unticked** and requires a decision.
- The **source line is shown verbatim** beside each candidate. The operator is
  comparing against a page; showing what was read is what makes that possible.
- Every value is editable, and **editing promotes it to full confidence**. A
  retyped value is a manual entry that happened to arrive beside a document;
  keeping the parser's score on a number a person read off the page themselves
  would permanently understate it.

## 3. There is no model here

§10.0: *"The model never computes, discovers, or asserts."* Reading a number off
a page and putting it in a medical record is computing, and §12 puts the AI
layer in December regardless.

So the parser is regular expressions over a PDF's embedded text layer —
`extraction_method = 'native_text'`, no network, and no egress of a document
carrying the operator's name, their address and their doctor's.

Four decisions inside it are worth knowing:

**It only recognises what the catalogue knows.** A general "name, number, unit,
range" pattern was written and rejected: it matches the patient's age, the
sample id, the page number and the footer's phone number, and each becomes a
plausible-looking candidate. A parser that proposes rubbish trains the operator
to tick boxes without reading, which defeats the only safety property this
pipeline has. Unmatched lines are **counted and reported** — a report with
thirty result lines and eleven candidates is a partial extraction, and saying so
is the difference between "the panel had eleven analytes" and "this system
recognised eleven of them".

**It splits on the first bare number token, not the first digit.**
`Vitamin D (25-OH) 14.2` has its first digit *inside the analyte's own name*. A
digit scan reads that report as a vitamin D of 25 ng/mL. There is a test.

**The label match has to be tight.** `Vitamin D` is an alias, so a lab reporting
`Vitamin D Binding Protein` would otherwise hand a different molecule to the
vitamin D chart. A leading collection qualifier (`Serum`, `Plasma`) is stripped,
and the matched alias must then cover at least half of what remains. `Serum TSH`
resolves; `Vitamin D Binding Protein` does not, and is reported as unmatched —
the right failure, because a missing candidate is visible and a wrong one is not.

**Ambiguous dates are refused.** `12/09/2026` is 12 September in Mumbai and
9 December in Boston, and nothing in the document settles it. A collection date
anchors a whole panel on a twenty-year timeline, so the parser returns one only
when it is unambiguous — ISO, a named month, or a first number past the twelfth.
Otherwise the operator types six characters, once, and the field says why.

**Single-letter flags are not read.** `L` beside a value might mean "low"; it is
also a perfectly good unit. Only spelled-out words are recognised. A missed flag
loses nothing: the printed range is still captured, `effectiveFlag` derives one,
and the screen labels it as derived.

## 4. The file itself is not stored, and the screen says so

§5.5 puts every document here in the private or sensitive tier. The encrypted
upload path does not exist yet.

The choice was between building a plaintext upload "for now" and building the
text-first design. §14.4 settles it — *deferring photography is permitted,
deferring encryption is not* — and the practical argument agrees: a temporary
plaintext path for medical documents is the one that never gets retrofitted.

So the browser reads the file, the text is posted, and `media_object_id` stays
null. What exists is a **record** of the document: title, issuer, dates, and its
full text, searchable. What is missing is the ability to look at the original
page, and the document screen states that plainly rather than implying it is
there.

The PDF reader is deliberately naive — it walks the uncompressed text operators
of the content stream. It handles the text-layer PDFs lab portals produce; it
does not handle scans or compressed streams. `pdfjs-dist` is roughly a megabyte
and C3 makes every dependency something one person maintains for twenty years.
When the reader finds nothing, the **paste box is already on screen with equal
prominence** — "extraction failed, try again" is a dead end, and pasting takes
ten seconds and works for every report ever printed.

## 5. Provenance, which is the whole point

§4.11:

> "a lab PDF dropped into the vault becomes structured lab observations with the
> source document permanently attached as evidence — so the number in your chart
> can always be traced back to the piece of paper it came from. **Provenance is
> not optional in a medical record.**"

A confirmed panel writes three things per result in one transaction:

1. a `lab_result` row holding the value **and the range exactly as printed**
2. an `observation` against `health.lab.<analyte>`, so it trends (P3)
3. `lab_result.observation_id`, the link between them

The observation's `source_id` points at an `observation_source` row of kind
`document_extraction` carrying the `document_id` — **one source row per
document**, not one shared by every extraction, because a shared row breaks the
trace the moment a second report is imported.

§9.9's confidence is **kept rather than consumed**: the parse score lands on
`observation.confidence`, and a value the operator retyped lands with no
confidence at all, which is how a manual entry is recorded.

Break any one of those three and the record still looks fine. That is why they
are one transaction rather than three calls, and why the integration test
asserts the join rather than the rows.

## 6. Idempotency

A confirmation retried after a network failure must not double the panel. Result
ids are derived from the panel id and the candidate's line number — an FNV-1a
hash, chosen for determinism rather than collision resistance, over an input
space of eighty lines in one document. `ON CONFLICT DO NOTHING` then recognises
the replay. There is a test that confirms twice and counts the rows.

## 7. What is not built

| Not built | Why |
|---|---|
| Encrypted file storage | §5.5's envelope encryption. Until it exists nothing is uploaded, and there is no half-wired plaintext path to retrofit. |
| OCR for scans | The `ocr` extraction method is in the enum and has no implementation, deliberately unstubbed — a stub returning nothing looks exactly like a document with no text. The paste box covers the case today. |
| Expiry reminders | `expiringSoon` is a filter and is not wired to a surface. §5.9 makes notifications opt-in, and a vault that emails about an insurance renewal is a vault that gets muted. Wiring it to a passive list is one screen's work when there is a document with an expiry in it. |
| Re-reading a document with a better parser | `document_extraction` accumulates rather than replaces, so this is already possible in the schema. No UI triggers it. |
