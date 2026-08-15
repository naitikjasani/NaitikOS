'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { uuidV7 } from '@naitikos/shared';
import { DOCUMENT_KINDS, DOCUMENT_KIND_LABELS, formatDay, systemClock } from '@naitikos/core';
import type { DocumentKind, VaultDocument } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  DateField,
  EmptyState,
  Inline,
  Stack,
  Text,
  TextAreaField,
  TextField,
} from '@naitikos/design-system';

import { fileDocument, readPdfText } from '../services/documentClient';

/**
 * `/life/documents` — the vault (§4.11).
 *
 * ## The file stays on the device, and the screen says so
 *
 * §5.5 puts every document here in the private or sensitive tier, and the
 * encrypted upload path does not exist yet. Rather than build a plaintext
 * upload "for now" — the shortcut §14.4 forbids, and the one that never gets
 * retrofitted — this files the document's *text* and its metadata, and states
 * plainly that the file itself was not stored.
 *
 * A record of a lab report, fully searchable, with its results in the register
 * is most of the value. What is missing is the ability to look at the original
 * page, and saying so is better than implying it is there.
 *
 * ## The paste box is not a fallback nobody finds
 *
 * The PDF reader here is deliberately naive (see `documentClient.ts`). When it
 * finds nothing — a scan, a compressed stream — the paste box is already on the
 * screen with the same prominence, because "extraction failed, try again" is a
 * dead end and pasting text takes ten seconds.
 */
export function VaultScreen({ documents }: { readonly documents: readonly VaultDocument[] }): ReactNode {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<DocumentKind>('lab_report');
  const [issuer, setIssuer] = useState('');
  const [issuedDay, setIssuedDay] = useState('');
  const [text, setText] = useState('');
  const [readNote, setReadNote] = useState<string | null>(null);

  const file = useMutation({
    mutationFn: async () => {
      const id = uuidV7(systemClock.nowMillis());
      const response = await fileDocument({
        id,
        kind,
        title: title.trim(),
        issuer: issuer.trim() === '' ? null : issuer.trim(),
        issuedAt: issuedDay === '' ? null : `${issuedDay}T12:00:00.000Z`,
        expiresAt: null,
        note: null,
        extractedText: text.trim() === '' ? null : text,
      });
      return response;
    },
    onSuccess: (response) => {
      setOpen(false);
      setTitle('');
      setIssuer('');
      setIssuedDay('');
      setText('');
      setReadNote(null);
      /* Straight into the review when there is something to review. The
       * candidates are the reason the document was filed; making the operator
       * find the document again to see them is a step that exists only because
       * it was easier to build. */
      if (response.candidates.length > 0) router.push(`/life/documents/${response.document.id}`);
      else router.refresh();
    },
  });

  const usable = title.trim() !== '';

  return (
    <Stack gap="6">
      {open ? (
        <Card variant="raised">
          <CardBody>
            <Stack gap="4">
              <Text role="title-3" as="h2">
                File a document
              </Text>

              <TextField
                label="Title"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                }}
                placeholder="Full body panel, September 2026"
              />

              <Stack gap="2">
                <Text role="caption" tone="tertiary">
                  Kind
                </Text>
                <Inline gap="2" wrap>
                  {DOCUMENT_KINDS.map((option) => (
                    <Button
                      key={option}
                      size="sm"
                      variant={option === kind ? 'primary' : 'secondary'}
                      aria-pressed={option === kind}
                      onClick={() => {
                        setKind(option);
                      }}
                    >
                      {DOCUMENT_KIND_LABELS[option]}
                    </Button>
                  ))}
                </Inline>
              </Stack>

              <Inline gap="2">
                <TextField
                  label="Issuer (optional)"
                  value={issuer}
                  onChange={(event) => {
                    setIssuer(event.target.value);
                  }}
                  placeholder="Metropolis"
                />
                <DateField label="Issued (optional)" value={issuedDay} onValueChange={setIssuedDay} />
              </Inline>

              <Stack gap="2">
                <Text role="caption" tone="tertiary">
                  The report&rsquo;s text
                </Text>
                <input
                  type="file"
                  accept="application/pdf,text/plain"
                  aria-label="Read text from a PDF"
                  onChange={(event) => {
                    const chosen = event.target.files?.[0];
                    if (chosen === undefined) return;
                    void (async () => {
                      const extracted =
                        chosen.type === 'text/plain' ? await chosen.text() : await readPdfText(chosen);
                      setText(extracted);
                      setReadNote(
                        extracted.trim() === ''
                          ? 'No text layer found — this is probably a scan. Paste the text below instead.'
                          : `Read ${String(extracted.length)} characters. Check it below.`,
                      );
                    })();
                  }}
                />
                <Text role="caption" tone="tertiary" aria-live="polite">
                  {readNote ??
                    'The file is read here, on your device, and is not uploaded. Only the text and what you confirm from it is stored.'}
                </Text>
                <TextAreaField
                  label="Text"
                  labelHidden
                  value={text}
                  rows={8}
                  onChange={(event) => {
                    setText(event.target.value);
                  }}
                  hint="Paste it if the file is a scan. Values you confirm from this become results; the text itself stays searchable."
                />
              </Stack>

              <Inline gap="2" justify="between" align="center">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setOpen(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={!usable || file.isPending}
                  onClick={() => {
                    file.mutate();
                  }}
                >
                  File it
                </Button>
              </Inline>

              {file.error !== null && (
                <Text role="body-sm" tone="secondary">
                  {file.error instanceof Error ? file.error.message : 'Could not file that.'}
                </Text>
              )}
            </Stack>
          </CardBody>
        </Card>
      ) : (
        <Inline justify="end">
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(true);
            }}
          >
            File a document
          </Button>
        </Inline>
      )}

      {documents.length === 0 ? (
        <EmptyState
          icon="domain.journal"
          title="The vault is empty"
          description="Lab reports, prescriptions and insurance papers. A lab report filed here becomes results you can confirm into your record."
        />
      ) : (
        <Stack gap="2">
          {documents.map((document) => (
            <Card key={document.id} variant="outlined">
              <CardBody>
                <Inline justify="between" align="center" wrap>
                  <Stack gap="1">
                    <Link className="nos-inline-link" href={`/life/documents/${document.id}`}>
                      {document.title}
                    </Link>
                    <Text role="caption" tone="tertiary">
                      {DOCUMENT_KIND_LABELS[document.kind]}
                      {document.issuer === null ? '' : ` · ${document.issuer}`}
                      {document.issuedAt === null ? '' : ` · ${formatDay(document.issuedAt) ?? ''}`}
                    </Text>
                  </Stack>
                  {document.hasExtraction && <Badge tone="neutral">Text on file</Badge>}
                </Inline>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
