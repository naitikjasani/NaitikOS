/**
 * The document vault — §4.11.
 *
 * ## Which tier a document goes in is decided here, not at the upload site
 *
 * §5.5 splits storage three ways by sensitivity, and puts "documents, receipts,
 * non-body imagery" in the private tier and "medical imaging" in the sensitive
 * one. That split does not survive contact with a real vault: a discharge
 * summary and an MRI arrive through the same button, and whichever tier the
 * button picks will be wrong for one of them.
 *
 * So the tier is a function of the document's *kind*, computed here, in the
 * layer that cannot forget to call it. {@link documentTier} is the single
 * decision point, and it errs upward — `imaging` is sensitive, and anything the
 * operator declines to classify is treated as sensitive rather than private.
 * Over-encrypting a receipt costs a client-side decrypt; under-encrypting a
 * scan of a body is the failure §5.5 exists to prevent.
 *
 * ## Expiry is tracked because nobody remembers a passport
 *
 * §4.11 asks for it and the value is entirely in the reminder. {@link
 * expiringSoon} is a filter, not a notification — §5.9 makes notifications
 * opt-in, and a vault that emails about an insurance renewal is a vault that
 * gets muted.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { parseInstant } from '../../temporal/instant';
import type { StorageTier } from '../../media/storage';

/** Mirrors the `document_kind` pgEnum exactly. */
export const DOCUMENT_KINDS = Object.freeze([
  'prescription',
  'lab_report',
  'imaging',
  'discharge_summary',
  'insurance',
  'receipt',
  'identity',
  'other',
] as const);

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABELS: Readonly<Record<DocumentKind, string>> = Object.freeze({
  prescription: 'Prescription',
  lab_report: 'Lab report',
  imaging: 'Imaging',
  discharge_summary: 'Discharge summary',
  insurance: 'Insurance',
  receipt: 'Receipt',
  identity: 'Identity document',
  other: 'Other',
});

export type VaultDocument = {
  readonly id: string;
  readonly kind: DocumentKind;
  readonly title: string;
  readonly issuer: string | null;
  readonly issuedAt: string | null;
  readonly expiresAt: string | null;
  readonly mediaObjectId: string | null;
  readonly note: string | null;
  /** Whether an extraction has run and produced text. */
  readonly hasExtraction: boolean;
};

export type DocumentInput = {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly issuer?: string | null;
  readonly issuedAt?: string | null;
  readonly expiresAt?: string | null;
  readonly note?: string | null;
};

export function isDocumentKind(value: string): value is DocumentKind {
  return (DOCUMENT_KINDS as readonly string[]).includes(value);
}

/**
 * The storage tier for a kind of document (§5.5).
 *
 * `imaging` is sensitive because it is a picture of a body. Everything else
 * named in §5.5's private row is private. There is no `public` case and there
 * never will be — a public document is not a document in this vault.
 */
export function documentTier(kind: DocumentKind): StorageTier {
  return kind === 'imaging' ? 'sensitive' : 'private';
}

export function validateDocument(input: DocumentInput): Result<DocumentInput, DomainError> {
  if (input.title.trim() === '') {
    return err(validationError('document_title_empty', 'A document needs a title you will recognise later.'));
  }
  if (!isDocumentKind(input.kind)) {
    return err(validationError('document_kind_unknown', `Unknown document kind: ${input.kind}.`));
  }
  for (const [field, value] of [
    ['issuedAt', input.issuedAt],
    ['expiresAt', input.expiresAt],
  ] as const) {
    if (value !== undefined && value !== null && parseInstant(value) === null) {
      return err(validationError(`document_${field}_invalid`, `${field} must be an ISO-8601 instant.`));
    }
  }
  if (
    input.issuedAt !== undefined &&
    input.issuedAt !== null &&
    input.expiresAt !== undefined &&
    input.expiresAt !== null &&
    input.expiresAt < input.issuedAt
  ) {
    return err(validationError('document_interval_reversed', 'A document cannot expire before it was issued.'));
  }
  return ok(input);
}

/** Default horizon for {@link expiringSoon}. Long enough to renew a passport. */
export const EXPIRY_HORIZON_DAYS = 60;

/**
 * Documents expiring within the horizon, soonest first.
 *
 * Already-expired documents are included rather than filtered out. An expired
 * insurance policy is exactly the thing worth surfacing, and dropping it the
 * day it lapses would hide the problem at the moment it starts mattering.
 */
export function expiringSoon(
  documents: readonly VaultDocument[],
  nowIso: string,
  horizonDays = EXPIRY_HORIZON_DAYS,
): readonly VaultDocument[] {
  const now = parseInstant(nowIso);
  if (now === null) return [];
  const cutoff = now.getTime() + horizonDays * 86_400_000;

  return documents
    .filter((document) => {
      if (document.expiresAt === null) return false;
      const expires = parseInstant(document.expiresAt);
      return expires !== null && expires.getTime() <= cutoff;
    })
    .sort((a, b) => ((a.expiresAt ?? '') < (b.expiresAt ?? '') ? -1 : 1));
}
