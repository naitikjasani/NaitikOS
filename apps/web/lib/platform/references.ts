/**
 * Turning §10.10's references into the figures a person reads.
 *
 * The one place in the system where a model-supplied identifier becomes a
 * displayed value. `@naitikos/ai` owns the reference format and the
 * substitution; `@naitikos/db` owns the lookup; this owns the translation
 * between them, because it is the only layer allowed to see both (§5.0).
 *
 * ## Why the translation is not in the repository
 *
 * The obvious shape is a repository method taking `Reference[]`. It would
 * require `db` to import `@naitikos/ai`, and §5.0 puts `ai` *above* `db` — so
 * the dependency runs backwards. The deeper reason is that a reference is a
 * fact about a model's output format, and the database layer has no business
 * knowing that format exists.
 *
 * ## A superseded observation renders as it was, and says so
 *
 * §9.1 makes a correction a supersession rather than an edit. An answer written
 * on Tuesday cited what was true on Tuesday; rendering Thursday's correction in
 * its place would make a saved answer say something the model never said. So
 * the stored value is rendered and the correction is *reported*, which lets the
 * surface mark it without rewriting history.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError } from '@naitikos/core';
import type { Narration, Reference, ReferenceValues, RenderedNarration } from '@naitikos/ai';
import { referenceKey, referencesIn, renderNarration } from '@naitikos/ai';
import type { Database } from '@naitikos/db';
import { createReferenceRepository } from '@naitikos/db';

export type ResolvedReferences = {
  readonly values: ReferenceValues;
  /** Keys whose observation has been corrected since the answer was written. */
  readonly supersededKeys: ReadonlySet<string>;
  /** References nothing could be found for. Rendered as a gap, never a number. */
  readonly missing: readonly Reference[];
};

/**
 * Resolve a batch of references.
 *
 * Deduplicated by the caller through `referencesIn`, grouped by kind here, one
 * query per kind. An eight-paragraph answer naming one observation four times
 * costs one row read.
 */
export async function resolveReferences(
  db: Database,
  references: readonly Reference[],
): Promise<Result<ResolvedReferences, DomainError>> {
  const values = new Map<string, string>();
  const supersededKeys = new Set<string>();
  const missing: Reference[] = [];

  if (references.length === 0) {
    return ok({ values, supersededKeys, missing });
  }

  const observationIds: string[] = [];
  const metricKeys: string[] = [];
  const nodeIds: string[] = [];
  const documentIds: string[] = [];
  const findingIds: string[] = [];

  for (const reference of references) {
    switch (reference.kind) {
      case 'observation':
        observationIds.push(reference.observationId);
        break;
      case 'metric':
        metricKeys.push(reference.metricKey);
        break;
      case 'entity':
        nodeIds.push(reference.nodeId);
        break;
      case 'document':
        documentIds.push(reference.documentId);
        break;
      default:
        findingIds.push(reference.findingId);
    }
  }

  const rows = await createReferenceRepository(db).lookup({
    observationIds,
    metricKeys,
    nodeIds,
    documentIds,
    findingIds,
  });
  if (!rows.ok) return rows;

  for (const reference of references) {
    const key = referenceKey(reference);

    switch (reference.kind) {
      case 'observation': {
        const found = rows.value.observations.get(reference.observationId);
        if (found === undefined) break;
        values.set(key, found.text);
        if (found.superseded) supersededKeys.add(key);
        break;
      }
      case 'metric': {
        const found = rows.value.metrics.get(reference.metricKey);
        if (found !== undefined) values.set(key, found);
        break;
      }
      case 'entity': {
        const found = rows.value.entities.get(reference.nodeId);
        if (found !== undefined) values.set(key, found);
        break;
      }
      case 'document': {
        const found = rows.value.documents.get(reference.documentId);
        if (found !== undefined) values.set(key, found);
        break;
      }
      default: {
        const found = rows.value.findings.get(reference.findingId);
        if (found === undefined) break;
        /*
         * Only `p` and `effectSize` are stored. The other four fields
         * `statisticRefSchema` permits — `r`, `n`, `lagDays`, `windowDays` —
         * fall through to `missing` and render as a gap. The repository's
         * header records why that drift is left visible rather than papered
         * over here.
         */
        const stored =
          reference.field === 'p' ? found.p
          : reference.field === 'effectSize' ? found.effectSize
          : null;
        if (stored !== null) values.set(key, stored);
        break;
      }
    }

    if (!values.has(key)) missing.push(reference);
  }

  return ok({ values, supersededKeys, missing });
}

export type RenderedParagraph = {
  readonly rendered: RenderedNarration;
  /** True when any figure in this paragraph has since been corrected. */
  readonly hasSuperseded: boolean;
};

/**
 * Resolve and render a set of narrations in one pass.
 *
 * What a screen calls. Returns a paragraph per narration, in order, each
 * already substituted — so the component maps over segments and never touches
 * a reference itself.
 */
export async function renderNarrations(
  db: Database,
  narrations: readonly Narration[],
): Promise<Result<readonly RenderedParagraph[], DomainError>> {
  const resolved = await resolveReferences(db, referencesIn(narrations));
  if (!resolved.ok) return resolved;

  return ok(
    narrations.map((narration) => {
      const rendered = renderNarration(narration, resolved.value.values);
      return {
        rendered,
        hasSuperseded: narration.references.some((reference) =>
          resolved.value.supersededKeys.has(referenceKey(reference)),
        ),
      };
    }),
  );
}
