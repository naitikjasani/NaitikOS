/**
 * `/api/documents` — the vault index, and filing a new document.
 *
 * ## The text arrives in the request body
 *
 * The browser reads the PDF's text layer and posts it. §5.5 puts every document
 * in the private or sensitive tier and the encrypted upload path does not exist
 * yet, so the *file* stays on the device; what crosses the wire is text the
 * operator has effectively already read.
 *
 * That ordering is deliberate rather than convenient. Parsing server-side would
 * require storing the file first, and storing it before encryption exists is
 * exactly the shortcut §14.4 forbids — the temporary plaintext path is the one
 * that never gets retrofitted.
 *
 * ## Filing does not write to the record
 *
 * The response carries *candidates*. Nothing reaches the observation log until
 * `/api/documents/:id/confirm`, and the gap between the two is the only moment
 * at which a mis-parsed number can still be stopped (§9.1 makes observations
 * append-only).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createDocumentRequestSchema, documentSearchSchema } from '@naitikos/api';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
} from '@/lib/platform/context';
import { fileDocument, listDocuments, searchDocuments } from '@/lib/platform/documents';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'observation:read');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const term = request.nextUrl.searchParams.get('q');

  try {
    if (term !== null) {
      const query = documentSearchSchema.safeParse({ q: term });
      /* An unparseable search is an empty result, not a 400. The box is a
       * search box; the only thing a person can do wrong in one is type. */
      if (!query.success) return NextResponse.json({ documents: [] });
      const found = await searchDocuments(platform.db, query.data.q);
      if (!found.ok) return errorResponse(found.error, traceId);
      return NextResponse.json({ documents: found.value });
    }

    const documents = await listDocuments(platform.db);
    if (!documents.ok) return errorResponse(documents.error, traceId);
    return NextResponse.json({ documents: documents.value });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in documents.get', {
      traceId,
      component: 'documents.get',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'settings:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, createDocumentRequestSchema, traceId);
  if ('response' in parsed) return parsed.response;

  try {
    const filed = await fileDocument(platform.db, {
      id: parsed.data.id,
      kind: parsed.data.kind,
      title: parsed.data.title,
      issuer: parsed.data.issuer ?? null,
      issuedAt: parsed.data.issuedAt ?? null,
      expiresAt: parsed.data.expiresAt ?? null,
      note: parsed.data.note ?? null,
      extractedText: parsed.data.extractedText ?? null,
    });
    if (!filed.ok) return errorResponse(filed.error, traceId);

    return NextResponse.json(
      {
        document: filed.value.document,
        candidates: filed.value.parsed?.candidates ?? [],
        unmatchedLines: filed.value.parsed?.unmatchedLines ?? 0,
        collectedOn: filed.value.parsed?.collectedOn ?? null,
      },
      { status: 201 },
    );
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in documents.post', {
      traceId,
      component: 'documents.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
