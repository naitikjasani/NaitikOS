'use client';

import { useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  PACK_SECTIONS,
  PACK_SECTION_TITLES,
  PACK_SPECIALTIES,
  leadCount,
} from '@naitikos/core';
import type { ConsultationPackDocument, PackSection } from '@naitikos/core';
import { Button, Divider, Inline, Stack, Text } from '@naitikos/design-system';

/**
 * `/timeline/medical/pack` — §10.7's Consultation Pack.
 *
 *   "This is P5 as a deliverable rather than a disclaimer: the system's
 *    clinical output is a better conversation with a qualified human."
 *
 * ## It is a document, not a dashboard
 *
 * No cards, no charts, no colour-coded status. A clinician gets ten minutes and
 * reads a page; the layout is a printed document because that is the artifact
 * §10.7 asks for and because it is what will actually be handed across a desk.
 * Everything on it is text, in reading order, with the sections in §10.7's own
 * order.
 *
 * ## The limitation is printed, not shown in a tooltip
 *
 * A document that looked like a medical record without saying it was
 * self-recorded would be presenting itself as something it is not — to someone
 * with thirty seconds to decide how much to trust it. So it is the first thing
 * under the heading, on paper and on screen.
 *
 * ## Nothing here is editable
 *
 * §10.7 says the questions are "model-drafted... **then user-edited**", and
 * editing happens on the appointment screen, which owns the saved list. A
 * second editor here would be a second place for the same questions to diverge,
 * and the divergent one would be the one printed.
 */

export type ConsultationPackScreenProps = {
  readonly pack: ConsultationPackDocument;
};

export function ConsultationPackScreen({ pack }: ConsultationPackScreenProps): ReactNode {
  const router = useRouter();
  const params = useSearchParams();
  const [specialty, setSpecialty] = useState(pack.specialty);

  return (
    <Stack gap="5">
      {/* --- controls, which do not print --------------------------------- */}
      <div className="nos-no-print">
        <Stack gap="3">
          <Inline gap="2" wrap>
            {PACK_SPECIALTIES.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === specialty ? 'primary' : 'ghost'}
                onClick={() => {
                  setSpecialty(option);
                  const next = new URLSearchParams(params.toString());
                  next.set('specialty', option);
                  router.push(`/timeline/medical/pack?${next.toString()}`);
                }}
              >
                {option}
              </Button>
            ))}
          </Inline>

          <Inline justify="between" align="center" wrap>
            <Text role="caption" tone="tertiary">
              Choosing a specialty changes what leads. Nothing is removed from the pack.
            </Text>
            <Button
              variant="secondary"
              iconStart="action.download"
              onClick={() => {
                window.print();
              }}
            >
              Print
            </Button>
          </Inline>
        </Stack>
      </div>

      <article className="nos-pack">
        <header className="nos-pack__header">
          <Text role="title-2" as="h1">
            Consultation pack — {pack.specialty}
          </Text>
          <Text role="caption" tone="tertiary">
            {pack.fromDayKey} to {pack.toDayKey}
          </Text>
          {/*
            P5, printed. A clinician has thirty seconds to decide how much to
            trust this, and the honest answer needs to be on the page rather
            than behind an interaction.
          */}
          <p className="nos-pack__limitation">{pack.limitation}</p>
        </header>

        {PACK_SECTIONS.map((section) => (
          <PackSectionBlock key={section} section={section} pack={pack} />
        ))}
      </article>
    </Stack>
  );
}

function PackSectionBlock({
  section,
  pack,
}: {
  readonly section: PackSection;
  readonly pack: ConsultationPackDocument;
}): ReactNode {
  const rows = linesFor(section, pack);
  if (rows.length === 0) {
    return (
      <section className="nos-pack__section">
        <Text role="title-3" as="h2">
          {PACK_SECTION_TITLES[section]}
        </Text>
        {/* Stated rather than omitted. A missing section reads as an oversight;
            "nothing on record" is a fact a clinician can use. */}
        <p className="nos-pack__empty">Nothing on record for this window.</p>
      </section>
    );
  }

  const leads = leadCount(rows);
  const showDivider = leads > 0 && leads < rows.length;

  return (
    <section className="nos-pack__section">
      <Text role="title-3" as="h2">
        {PACK_SECTION_TITLES[section]}
      </Text>
      <ul className="nos-pack__list">
        {rows.map((row, index) => (
          <li key={row.key}>
            {showDivider && index === leads && (
              <>
                <Divider />
                <p className="nos-pack__aside">Also on record</p>
              </>
            )}
            <p className="nos-pack__line">{row.primary}</p>
            {row.secondary !== null && <p className="nos-pack__detail">{row.secondary}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

type Line = { readonly key: string; readonly primary: string; readonly secondary: string | null; readonly lead: boolean };

function linesFor(section: PackSection, pack: ConsultationPackDocument): readonly Line[] {
  switch (section) {
    case 'conditions':
      return pack.conditions.map((row) => ({
        key: row.id,
        primary: `${row.name} — ${row.status}${row.severity === null ? '' : `, ${row.severity}`}`,
        secondary: `since ${row.since.slice(0, 10)}${row.until === null ? '' : ` until ${row.until.slice(0, 10)}`}${row.diagnosedBy === null ? '' : ` · ${row.diagnosedBy}`}`,
        lead: row.lead,
      }));

    case 'medications':
      return pack.medications.map((row) => ({
        key: row.id,
        primary: `${row.label}${row.dose === null ? '' : ` — ${row.dose}`}${row.frequency === null ? '' : `, ${row.frequency}`}${row.stoppedAt === null ? '' : ' (stopped)'}`,
        /* The adherence *note*, never the bare percentage. "84% of 62 scheduled
         * doses were logged" is a fact; "84% adherence" is a claim about
         * behaviour, and a prescriber will hear the second unless it is said
         * the first way. */
        secondary: row.adherenceNote,
        lead: row.lead,
      }));

    case 'labs':
      return pack.labs.map((row) => ({
        key: row.resultId,
        primary: `${row.analyte}: ${row.value}${row.unit === null ? '' : ` ${row.unit}`}${row.flag === null ? '' : ` (${row.flag})`}`,
        secondary: [
          row.collectedAt === null ? null : `collected ${row.collectedAt.slice(0, 10)}`,
          row.rangeText === null ? null : `range ${row.rangeText}`,
          row.previous === null
            ? null
            : `previously ${row.previous.value}${row.previous.collectedAt === null ? '' : ` on ${row.previous.collectedAt.slice(0, 10)}`}`,
          /* §10.7's honesty about a flag this system computed. Presenting
           * arithmetic as a laboratory's judgement is the failure. */
          row.flagSource === 'derived' ? 'flag derived from the printed range, not printed on the report' : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' · '),
        lead: row.lead,
      }));

    case 'symptoms':
      return pack.symptoms.map((row) => ({
        key: row.id,
        primary: `${row.name}${row.bodySite === null ? '' : ` (${row.bodySite})`}`,
        secondary: `${String(row.occurrences)} ${row.occurrences === 1 ? 'episode' : 'episodes'}${row.startedAt === null ? '' : `, from ${row.startedAt.slice(0, 10)}`}${row.endedAt === null ? '' : ` to ${row.endedAt.slice(0, 10)}`}`,
        lead: row.lead,
      }));

    case 'treatments':
      return pack.treatments.map((row) => ({
        key: row.id,
        primary: row.label,
        secondary: [
          row.startedAt === null ? null : `from ${row.startedAt.slice(0, 10)}`,
          row.endedAt === null ? null : `to ${row.endedAt.slice(0, 10)}`,
          row.outcome === null ? 'outcome not recorded' : `outcome: ${row.outcome}`,
        ]
          .filter((part): part is string => part !== null)
          .join(' · '),
        lead: row.lead,
      }));

    default:
      return pack.questions.map((question) => ({
        key: question.id,
        primary: question.question,
        secondary: question.evidence === '' ? null : question.evidence,
        /* Every question leads. The ranking already happened in
         * `deriveQuestions`, and a second relevance filter over an
         * already-ranked list of eight would be filtering twice. */
        lead: true,
      }));
  }
}
