'use client';

/**
 * The document vault's client service (§7.3).
 *
 * ## Neither of these queues
 *
 * Filing a document returns the candidates the screen is about to render, so
 * there is nothing useful to do with a queued write — the operator would be
 * looking at an empty review screen waiting for a network they do not have.
 * Confirming writes backdated observations into an append-only log, which is
 * the one write in this system that most wants to happen while somebody is
 * watching.
 *
 * ## The PDF is read here, in the browser
 *
 * §5.5 puts every document in the private or sensitive tier and the encrypted
 * upload path does not exist yet, so the file itself does not leave the device.
 * What is posted is the text layer. See `app/api/documents/route.ts` for why
 * that ordering is deliberate rather than a stopgap.
 */

import type { CandidateLabResult, DocumentKind, VaultDocument } from '@naitikos/core';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function send<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { readonly message?: string } | null;
    throw new HttpError(response.status, detail?.message ?? `Request failed (${String(response.status)}).`);
  }
  return (await response.json()) as T;
}

export type FileDocumentDraft = {
  readonly id: string;
  readonly kind: DocumentKind;
  readonly title: string;
  readonly issuer: string | null;
  readonly issuedAt: string | null;
  readonly expiresAt: string | null;
  readonly note: string | null;
  readonly extractedText: string | null;
};

export type FileDocumentResponse = {
  readonly document: VaultDocument;
  readonly candidates: readonly CandidateLabResult[];
  readonly unmatchedLines: number;
  readonly collectedOn: string | null;
};

export async function fileDocument(draft: FileDocumentDraft): Promise<FileDocumentResponse> {
  return send('/api/documents', draft);
}

export type ConfirmDraft = {
  readonly documentId: string;
  readonly panelId: string;
  readonly panelName: string;
  readonly laboratory: string | null;
  readonly collectedAt: string;
  readonly zone: string;
  readonly decisions: readonly {
    readonly key: string;
    readonly accept: boolean;
    readonly correctedValue: string | null;
    readonly correctedUnit: string | null;
  }[];
};

export type ConfirmResponse = {
  readonly panelId: string;
  readonly written: number;
  readonly withoutTrend: readonly { readonly analyte: string; readonly reason: string }[];
};

export async function confirmResults(draft: ConfirmDraft): Promise<ConfirmResponse> {
  const { documentId, ...body } = draft;
  return send(`/api/documents/${documentId}/confirm`, body);
}

/**
 * Read a PDF's text layer in the browser.
 *
 * Deliberately naive, and honest about it. This walks the uncompressed text
 * operators of a PDF's content streams; it handles the text-layer PDFs that lab
 * portals produce and it does not handle scans, compressed streams, or embedded
 * fonts with custom encodings.
 *
 * A full PDF parser is a dependency — `pdfjs-dist` is roughly a megabyte — and
 * C3 makes every dependency something one person maintains for twenty years.
 * The fallback when this returns nothing is not a failure: the operator pastes
 * the text, which takes ten seconds and works for every report ever printed.
 * That path exists on the screen and is not hidden behind an error.
 */
export async function readPdfText(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const latin1 = new TextDecoder('latin1').decode(bytes);

  const chunks: string[] = [];
  /* `(text) Tj` and `[(a) -250 (b)] TJ` — the two operators that place text. */
  const pattern = /\((?:\\.|[^\\()])*\)/gu;
  let match: RegExpExecArray | null = pattern.exec(latin1);
  while (match !== null) {
    const raw = match[0].slice(1, -1);
    chunks.push(unescapePdfString(raw));
    match = pattern.exec(latin1);
  }

  return chunks.join(' ').replace(/\s{2,}/gu, ' ');
}

function unescapePdfString(raw: string): string {
  return raw
    .replace(/\\n/gu, '\n')
    .replace(/\\r/gu, '\n')
    .replace(/\\t/gu, ' ')
    .replace(/\\([()\\])/gu, '$1');
}
