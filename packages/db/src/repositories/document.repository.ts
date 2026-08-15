/**
 * The document vault, persisted — §4.11 and §9.9.
 *
 * ## The file itself is not here yet, and that is stated rather than stubbed
 *
 * §14.4 permits deferring photography and forbids deferring encryption, and the
 * same reasoning governs this vault: `mediaObjectId` is nullable and stays null
 * until the encrypted upload path exists. A document row without its file is a
 * *record* of a document — title, issuer, dates, and its extracted text — which
 * is most of the value, and it is honest about what it has.
 *
 * What is deliberately *not* built is a half-wired upload that writes plaintext
 * to storage "for now". §5.5 puts every one of these in the private or
 * sensitive tier, and a temporary plaintext path is the one that never gets
 * retrofitted.
 *
 * ## Extraction rows accumulate; they do not replace each other
 *
 * A document can be re-read by a better parser in 2029 and the old extraction
 * stays. §9.9 keeps `engine` and `engineVersion` for exactly this reason: an
 * observation cites the extraction that produced it, and deleting a superseded
 * extraction would orphan the provenance of every number it wrote.
 * {@link DocumentRepository.latestExtraction} is a read, not a lifecycle.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  DocumentExtraction,
  DocumentInput,
  DocumentKind,
  DomainError,
  ExtractedField,
  ExtractionMethod,
  VaultDocument,
} from '@naitikos/core';
import { notFoundError } from '@naitikos/core';

import type { Database } from '../client';
import { document, documentExtraction } from '../schema/crosscutting';

function toDocument(row: typeof document.$inferSelect, hasExtraction: boolean): VaultDocument {
  return {
    id: row.id,
    kind: row.kind as DocumentKind,
    title: row.title,
    issuer: row.issuer,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    mediaObjectId: row.mediaObjectId,
    note: row.note,
    hasExtraction,
  };
}

function toFields(value: unknown): readonly ExtractedField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ExtractedField[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const field = record['field'];
    const fieldValue = record['value'];
    if (typeof field !== 'string' || typeof fieldValue !== 'string') return [];
    return [
      {
        field,
        value: fieldValue,
        confidence: typeof record['confidence'] === 'number' ? record['confidence'] : 0,
        line: typeof record['line'] === 'number' ? record['line'] : null,
      },
    ];
  });
}

function toExtraction(row: typeof documentExtraction.$inferSelect): DocumentExtraction {
  return {
    id: row.id,
    documentId: row.documentId,
    method: row.method as ExtractionMethod,
    engine: row.engine,
    engineVersion: row.engineVersion,
    extractedText: row.extractedText,
    structuredFields: toFields(row.structuredFields),
    overallConfidence: row.overallConfidence,
  };
}

export type ExtractionInput = {
  readonly id: string;
  readonly documentId: string;
  readonly method: ExtractionMethod;
  readonly engine: string;
  readonly engineVersion: string;
  readonly extractedText: string;
  readonly structuredFields: readonly ExtractedField[];
  readonly overallConfidence: number | null;
};

export type DocumentRepository = {
  list(kind?: DocumentKind): Promise<Result<readonly VaultDocument[], DomainError>>;
  byId(id: string): Promise<Result<VaultDocument | null, DomainError>>;
  create(input: DocumentInput): Promise<Result<VaultDocument, DomainError>>;
  /** Full-text search over extracted text (§9.9's `search_vector`). */
  search(term: string, limit?: number): Promise<Result<readonly VaultDocument[], DomainError>>;
  latestExtraction(documentId: string): Promise<Result<DocumentExtraction | null, DomainError>>;
  recordExtraction(input: ExtractionInput): Promise<Result<DocumentExtraction, DomainError>>;
};

export function createDocumentRepository(db: Database): DocumentRepository {
  return {
    async list(kind) {
      const rows = await db
        .select({
          document,
          /* One boolean per document rather than a second round trip. The
           * vault index shows "extracted" as a state, and the alternative is
           * N+1 queries on a list that only grows. */
          extractions: sql<number>`(
            select count(*)::int from document_extraction de where de.document_id = ${document.id}
          )`,
        })
        .from(document)
        .where(kind === undefined ? isNull(document.deletedAt) : and(isNull(document.deletedAt), eq(document.kind, kind)))
        .orderBy(desc(document.issuedAt), desc(document.createdAt));

      return ok(rows.map((row) => toDocument(row.document, Number(row.extractions) > 0)));
    },

    async byId(id) {
      const rows = await db
        .select({
          document,
          extractions: sql<number>`(
            select count(*)::int from document_extraction de where de.document_id = ${document.id}
          )`,
        })
        .from(document)
        .where(and(eq(document.id, id), isNull(document.deletedAt)))
        .limit(1);

      const row = rows[0];
      return ok(row === undefined ? null : toDocument(row.document, Number(row.extractions) > 0));
    },

    async create(input) {
      const rows = await db
        .insert(document)
        .values({
          id: input.id,
          kind: input.kind as DocumentKind,
          title: input.title,
          issuer: input.issuer ?? null,
          issuedAt: input.issuedAt ?? null,
          expiresAt: input.expiresAt ?? null,
          note: input.note ?? null,
        })
        .onConflictDoNothing()
        .returning();

      const written = rows[0];
      if (written !== undefined) return ok(toDocument(written, false));

      const replayed = await db.select().from(document).where(eq(document.id, input.id)).limit(1);
      const row = replayed[0];
      return row === undefined ? { ok: false, error: notFoundError('document', input.id) } : ok(toDocument(row, false));
    },

    async search(term, limit = 25) {
      const trimmed = term.trim();
      if (trimmed === '') return ok([]);

      /*
       * `websearch_to_tsquery`, not `to_tsquery`.
       *
       * The operator types "vitamin d 2026" into a box, and `to_tsquery` throws
       * a syntax error on a bare space. `websearch_to_tsquery` accepts what a
       * person actually types, which is the only input this box will ever get.
       */
      const rows = await db
        .select({ document })
        .from(document)
        .innerJoin(documentExtraction, eq(documentExtraction.documentId, document.id))
        .where(
          and(
            isNull(document.deletedAt),
            sql`${documentExtraction.searchVector} @@ websearch_to_tsquery('english', ${trimmed})`,
          ),
        )
        .orderBy(desc(document.issuedAt))
        .limit(limit);

      const seen = new Set<string>();
      const unique: VaultDocument[] = [];
      for (const row of rows) {
        if (seen.has(row.document.id)) continue;
        seen.add(row.document.id);
        unique.push(toDocument(row.document, true));
      }
      return ok(unique);
    },

    async latestExtraction(documentId) {
      const rows = await db
        .select()
        .from(documentExtraction)
        .where(eq(documentExtraction.documentId, documentId))
        .orderBy(desc(documentExtraction.createdAt))
        .limit(1);
      const row = rows[0];
      return ok(row === undefined ? null : toExtraction(row));
    },

    async recordExtraction(input) {
      const rows = await db
        .insert(documentExtraction)
        .values({
          id: input.id,
          documentId: input.documentId,
          method: input.method,
          engine: input.engine,
          engineVersion: input.engineVersion,
          extractedText: input.extractedText,
          structuredFields: input.structuredFields,
          overallConfidence: input.overallConfidence === null ? null : input.overallConfidence.toFixed(2),
        })
        .onConflictDoNothing()
        .returning();

      const written = rows[0];
      if (written !== undefined) return ok(toExtraction(written));

      const replayed = await db
        .select()
        .from(documentExtraction)
        .where(eq(documentExtraction.id, input.id))
        .limit(1);
      const row = replayed[0];
      return row === undefined
        ? { ok: false, error: notFoundError('document_extraction', input.id) }
        : ok(toExtraction(row));
    },
  };
}
