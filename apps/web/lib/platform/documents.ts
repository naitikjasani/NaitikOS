/**
 * The document vault service — §4.11's clinical loop, assembled.
 *
 * The loop §12 asks for is "from lab PDF to trend to consultation question",
 * and it is four steps with a person in the middle of it:
 *
 *   1. the browser reads the PDF's text layer and posts it with the document
 *   2. {@link fileDocument} stores the document, the text, and the candidates
 *   3. the operator reviews the candidates and confirms
 *   4. {@link confirmLabResults} writes the panel, the results and the
 *      observations — and from there the trend and the question are ordinary
 *      reads over data that already exists
 *
 * Step 3 is not skippable and is not a formality. §9.1 makes observations
 * append-only, so a mis-parsed decimal point is permanent; the review is the
 * only moment at which a number can still be stopped.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  CandidateLabResult,
  DocumentInput,
  DocumentKind,
  DomainError,
  Hlc,
  MetricRegistry,
  ParsedLabReport,
  VaultDocument,
} from '@naitikos/core';
import {
  PARSER_ENGINE,
  PARSER_VERSION,
  analyteBySlug,
  confirmCandidates,
  hlcReceive,
  initialHlcState,
  isoFromMillis,
  isPreAccepted,
  normaliseUnit,
  overallConfidence,
  parseLabReport,
  systemClock,
  validateDocument,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import { createDocumentRepository, createLabRepository, createMetricRepository } from '@naitikos/db';

import type { OfflineEnvelope } from './capture';

export type FiledDocument = {
  readonly document: VaultDocument;
  /** Absent when the document carried no text layer. */
  readonly parsed: ParsedLabReport | null;
};

/**
 * File a document and, if it carries text, read it.
 *
 * The extraction row is written even when the parser finds nothing. A document
 * whose text was read and yielded no catalogued analytes is a different state
 * from one that was never read, and §9.9's `extractedText` is what makes the
 * first one searchable — which is most of the value of a vault.
 */
export async function fileDocument(
  db: Database,
  input: DocumentInput & { readonly extractedText?: string | null },
): Promise<Result<FiledDocument, DomainError>> {
  const validated = validateDocument(input);
  if (!validated.ok) return validated;

  const documents = createDocumentRepository(db);
  const created = await documents.create(input);
  if (!created.ok) return created;

  const text = input.extractedText ?? null;
  if (text === null || text.trim() === '') return ok({ document: created.value, parsed: null });

  const parsed = parseLabReport(text);

  const recorded = await documents.recordExtraction({
    id: crypto.randomUUID(),
    documentId: input.id,
    /* §9.9's `extraction_method`. `native_text` is exactly what this is: a
     * PDF's own text layer, read deterministically. Calling it `ocr` would
     * misdescribe the provenance of every number it produces. */
    method: 'native_text',
    engine: PARSER_ENGINE,
    engineVersion: PARSER_VERSION,
    extractedText: text,
    structuredFields: parsed.candidates.map((candidate) => ({
      field: candidate.analyteSlug,
      value: candidate.printedValue,
      confidence: candidate.confidence,
      line: candidate.line,
    })),
    overallConfidence: overallConfidence(parsed.candidates),
  });
  if (!recorded.ok) return recorded;

  return ok({ document: { ...created.value, hasExtraction: true }, parsed });
}

export type CandidateView = CandidateLabResult & {
  readonly displayName: string;
  readonly preAccepted: boolean;
  /** The unit as this system would store it, or `null` if it cannot. */
  readonly normalisedUnit: string | null;
};

export type DocumentDetail = {
  readonly document: VaultDocument;
  readonly extractedText: string | null;
  readonly candidates: readonly CandidateView[];
  readonly unmatchedLines: number;
  readonly collectedOn: string | null;
};

export async function loadDocument(db: Database, id: string): Promise<Result<DocumentDetail | null, DomainError>> {
  const documents = createDocumentRepository(db);

  const found = await documents.byId(id);
  if (!found.ok) return found;
  if (found.value === null) return ok(null);

  const extraction = await documents.latestExtraction(id);
  if (!extraction.ok) return extraction;

  const text = extraction.value?.extractedText ?? null;
  /*
   * Re-parsed on read rather than reconstructed from `structuredFields`.
   *
   * The stored fields are a *record* of what an extraction found, kept forever
   * for provenance. The review screen needs the full candidate — source line,
   * printed range, printed flag — and rebuilding that from four columns would
   * be a second parser that could disagree with the first.
   */
  const parsed = text === null ? null : parseLabReport(text);

  return ok({
    document: found.value,
    extractedText: text,
    candidates: (parsed?.candidates ?? []).map(toView),
    unmatchedLines: parsed?.unmatchedLines ?? 0,
    collectedOn: parsed?.collectedOn ?? null,
  });
}

function toView(candidate: CandidateLabResult): CandidateView {
  return {
    ...candidate,
    displayName: analyteBySlug(candidate.analyteSlug)?.displayName ?? candidate.analyteSlug,
    preAccepted: isPreAccepted(candidate),
    normalisedUnit: candidate.printedUnit === null ? null : normaliseUnit(candidate.printedUnit),
  };
}

export type ConfirmInput = {
  readonly documentId: string;
  readonly panelId: string;
  readonly panelName: string;
  readonly laboratory: string | null;
  readonly collectedAt: string;
  readonly zone: string;
  readonly decisions: readonly { readonly key: string; readonly accept: boolean; readonly correctedValue?: string | null; readonly correctedUnit?: string | null }[];
  readonly envelope: OfflineEnvelope;
};

export async function confirmLabResults(
  db: Database,
  input: ConfirmInput,
): Promise<Result<{ readonly panelId: string; readonly written: number; readonly withoutTrend: readonly { readonly analyte: string; readonly reason: string }[] }, DomainError>> {
  const documents = createDocumentRepository(db);
  const labs = createLabRepository(db);

  const extraction = await documents.latestExtraction(input.documentId);
  if (!extraction.ok) return extraction;

  const text = extraction.value?.extractedText ?? '';
  const parsed = parseLabReport(text);

  const confirmed = confirmCandidates(parsed, input.decisions);
  if (!confirmed.ok) return confirmed;

  const registry = await createMetricRepository(db).registry();
  if (!registry.ok) return registry;

  const recorded = await labs.recordPanel(
    {
      id: input.panelId,
      panelName: input.panelName,
      laboratory: input.laboratory,
      collectedAt: input.collectedAt,
      zone: input.zone,
      documentId: input.documentId,
      results: confirmed.value.map((result) => ({
        /*
         * Derived from the panel and the line, not random.
         *
         * A retried confirmation has to produce the same result ids or the
         * `ON CONFLICT DO NOTHING` in `recordPanel` cannot recognise the
         * replay, and the panel would gain a second copy of every result.
         */
        id: deterministicResultId(input.panelId, result.candidate.key),
        analyteSlug: result.candidate.analyteSlug,
        printedName: result.candidate.printedName,
        value: result.value,
        unit: result.unit,
        referenceLow: result.candidate.rangeLow,
        referenceHigh: result.candidate.rangeHigh,
        referenceText: result.candidate.rangeText,
        flag: result.candidate.printedFlag,
        confidence: result.confidence,
      })),
    },
    writeContext(registry.value, input.envelope),
  );
  if (!recorded.ok) return recorded;

  return ok({
    panelId: recorded.value.panelId,
    written: recorded.value.resultsWritten,
    withoutTrend: recorded.value.withoutTrend,
  });
}

/**
 * A stable id for a confirmed result, from the panel and the candidate key.
 *
 * Not a real UUIDv5 — there is no namespace hashing — but a well-formed UUID
 * derived deterministically, so that a retried confirmation maps onto the same
 * row and `recordPanel`'s `ON CONFLICT DO NOTHING` recognises the replay. A
 * random id would silently give the panel a second copy of every result.
 *
 * The panel id supplies the high bits; an FNV-1a hash of the candidate key
 * disambiguates within it. FNV rather than anything cryptographic: the property
 * needed is *determinism*, not collision resistance, and the input space is
 * eighty lines of one document.
 */
function deterministicResultId(panelId: string, key: string): string {
  const digits = panelId.replace(/-/gu, '').padEnd(32, '0');
  return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-5${digits.slice(13, 16)}-8${digits.slice(17, 20)}-${hash12(key)}`;
}

function hash12(key: string): string {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').padEnd(12, '0').slice(0, 12);
}

function writeContext(registry: MetricRegistry, envelope: OfflineEnvelope) {
  const physicalMillis = systemClock.nowMillis();
  const seed = initialHlcState(envelope.deviceId, physicalMillis);
  const state =
    envelope.clientHlc === undefined ? seed : hlcReceive(seed, envelope.clientHlc as Hlc, physicalMillis).state;

  return {
    registry,
    hlcState: state,
    recordedAt: isoFromMillis(physicalMillis),
    physicalMillis,
    newId: () => crypto.randomUUID(),
  };
}

export async function listDocuments(
  db: Database,
  kind?: DocumentKind,
): Promise<Result<readonly VaultDocument[], DomainError>> {
  return createDocumentRepository(db).list(kind);
}

export async function searchDocuments(db: Database, term: string): Promise<Result<readonly VaultDocument[], DomainError>> {
  return createDocumentRepository(db).search(term);
}
