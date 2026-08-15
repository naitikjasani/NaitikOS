/**
 * Document vault contracts — §4.11, §9.9.
 *
 * ## The text arrives from the client, and that is the whole point
 *
 * `extractedText` is sent by the browser, because the browser is where the PDF
 * is. §5.5 puts every document in the private or sensitive tier and the
 * encrypted upload path does not exist yet, so the file itself never leaves the
 * device — what crosses the wire is the text the operator has, in effect,
 * already read.
 *
 * That is a deliberate ordering. Parsing server-side from a stored file would
 * require storing the file first, and storing it before the encryption path
 * exists is precisely the shortcut §14.4 forbids ("deferring photography is
 * permitted; deferring encryption is not"). The text-first design lets the
 * clinical loop work today without leaving a plaintext upload path behind to
 * retrofit.
 *
 * ## Confirmation is a separate request from extraction
 *
 * `POST /documents` parses and returns candidates; nothing is written to the
 * observation log. `POST /documents/:id/confirm` writes what the operator
 * accepted. Two round trips, on purpose — the gap between them is where a
 * person looks at a number before it becomes permanent, and §9.1's append-only
 * log means that gap is the only chance anyone gets.
 */

import { z } from 'zod';

import { instantSchema, uuidSchema, zoneSchema } from './timeline';

export const documentKindSchema = z.enum([
  'prescription',
  'lab_report',
  'imaging',
  'discharge_summary',
  'insurance',
  'receipt',
  'identity',
  'other',
]);

/** Roughly forty pages of dense text. Past that it is not a document, it is a book. */
export const MAX_EXTRACTED_CHARACTERS = 200_000;

export const createDocumentRequestSchema = z.object({
  id: uuidSchema,
  kind: documentKindSchema,
  title: z.string().min(1).max(200),
  issuer: z.string().max(200).nullish(),
  issuedAt: instantSchema.nullish(),
  expiresAt: instantSchema.nullish(),
  note: z.string().max(2000).nullish(),
  /**
   * The PDF's text layer, read in the browser.
   *
   * Optional: a document with no text layer — a photograph of a prescription —
   * is still worth filing. It simply produces no candidates, which is stated
   * on the screen rather than left to look like a parse that found nothing.
   */
  extractedText: z.string().max(MAX_EXTRACTED_CHARACTERS).nullish(),
});

export const confirmLabResultsRequestSchema = z.object({
  /** The panel row this creates. Client-generated, so a retry is idempotent. */
  panelId: uuidSchema,
  panelName: z.string().min(1).max(200),
  laboratory: z.string().max(200).nullish(),
  /**
   * Required, and often typed rather than parsed.
   *
   * The parser refuses an ambiguous `12/09/2026` — see `lab-parser.ts` — and
   * this is the field the operator fills in when it does. A collection date
   * anchors a whole panel on a twenty-year timeline; six characters of typing
   * is the correct price for not guessing.
   */
  collectedAt: instantSchema,
  zone: zoneSchema,
  decisions: z
    .array(
      z.object({
        key: z.string().min(1).max(40),
        accept: z.boolean(),
        correctedValue: z
          .string()
          .regex(/^-?\d+(\.\d+)?$/u, 'A decimal number.')
          .nullish(),
        correctedUnit: z.string().max(40).nullish(),
      }),
    )
    .min(1)
    .max(80),
});

export const documentSearchSchema = z.object({ q: z.string().min(1).max(200) });

export type CreateDocumentRequest = z.infer<typeof createDocumentRequestSchema>;
export type ConfirmLabResultsRequest = z.infer<typeof confirmLabResultsRequestSchema>;
