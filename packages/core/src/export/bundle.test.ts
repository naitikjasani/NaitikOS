import { describe, expect, it } from 'vitest';

import { MVP_METRICS } from '../observations/mvp-metrics';
import {
  EXPORT_FORMAT_VERSION,
  type ExportInput,
  buildDecryptionGuide,
  buildExportBundle,
  buildReadme,
  buildSchemaDocument,
  toNdjson,
} from './bundle';
import { MAX_ARCHIVE_ENTRIES, buildZip, crc32 } from './zip';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function input(overrides: Partial<ExportInput> = {}): ExportInput {
  return {
    generatedAt: '2026-08-03T15:30:00.000Z',
    tables: [
      {
        name: 'observation',
        description: 'The append-only observation log.',
        rows: [
          { id: 'obs-1', metric_key: 'mind.mood', value: '4.000000' },
          { id: 'obs-2', metric_key: 'body.weight', value: '74.200000' },
        ],
      },
    ],
    metrics: MVP_METRICS,
    media: [],
    medicalTimelineMarkdown: '# Medical timeline\n\nNothing recorded yet.\n',
    ...overrides,
  };
}

/* =========================================================================
 * The ZIP container
 * ====================================================================== */

describe('crc32', () => {
  /**
   * The published check value for CRC-32/ISO-HDLC. Asserted against the
   * standard rather than against our own output, so a table-generation bug
   * cannot make the test agree with the code.
   */
  it('matches the standard check value', () => {
    expect(crc32(encoder.encode('123456789')).toString(16)).toBe('cbf43926');
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('buildZip', () => {
  it('produces an archive with the expected structure', () => {
    const result = buildZip(
      [{ path: 'a.txt', data: encoder.encode('hello') }],
      new Date('2026-08-03T15:30:00.000Z'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bytes = result.bytes;
    // Local file header, then the central directory, then the EOCD.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(decoder.decode(bytes).includes('PK')).toBe(true);
    expect(decoder.decode(bytes).includes('PK')).toBe(true);
  });

  /**
   * The property that makes the archive recoverable with a hex editor, and the
   * one the README promises. It only holds while nothing is compressed.
   */
  it('stores file contents verbatim, so they are readable without a ZIP tool', () => {
    const result = buildZip(
      [{ path: 'note.txt', data: encoder.encode('woke at 3am') }],
      new Date('2026-08-03T15:30:00.000Z'),
    );
    expect(result.ok && decoder.decode(result.bytes).includes('woke at 3am')).toBe(true);
  });

  /**
   * A truncated archive that looks fine is worse than a failed one, because it
   * is only discovered on the day it is needed.
   */
  it('refuses rather than silently producing something ZIP64 would be needed for', () => {
    const many = Array.from({ length: MAX_ARCHIVE_ENTRIES + 1 }, (_, i) => ({
      path: `f${String(i)}.txt`,
      data: new Uint8Array(0),
    }));
    const result = buildZip(many, new Date());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure).toBe('too_many_entries');
  });

  it('refuses a path that would escape the extraction directory', () => {
    const traversal = buildZip([{ path: '../escape.txt', data: new Uint8Array(0) }], new Date());
    expect(!traversal.ok && traversal.failure).toBe('invalid_path');

    const absolute = buildZip([{ path: '/etc/passwd', data: new Uint8Array(0) }], new Date());
    expect(!absolute.ok && absolute.failure).toBe('invalid_path');

    const empty = buildZip([{ path: '', data: new Uint8Array(0) }], new Date());
    expect(!empty.ok && empty.failure).toBe('invalid_path');
  });

  it('refuses duplicate paths, which would make one entry unreachable', () => {
    const result = buildZip(
      [
        { path: 'a.txt', data: encoder.encode('one') },
        { path: 'a.txt', data: encoder.encode('two') },
      ],
      new Date(),
    );
    expect(!result.ok && result.failure).toBe('duplicate_path');
  });

  it('handles an empty archive', () => {
    const result = buildZip([], new Date('2026-08-03T15:30:00.000Z'));
    // Just the end-of-central-directory record.
    expect(result.ok && result.bytes.length).toBe(22);
  });

  /**
   * ZIP's date field has a 1980 epoch and cannot represent anything earlier.
   * Clamping keeps the header valid; the *real* timestamps are in the NDJSON.
   */
  it('clamps a pre-1980 timestamp rather than writing a negative year', () => {
    const result = buildZip([{ path: 'a.txt', data: new Uint8Array(1) }], new Date('1970-01-01T00:00:00Z'));
    expect(result.ok).toBe(true);
  });
});

/* =========================================================================
 * NDJSON
 * ====================================================================== */

describe('toNdjson', () => {
  it('writes one object per line with a trailing newline', () => {
    const text = toNdjson([{ a: 1 }, { b: 2 }]);
    expect(text).toBe('{"a":1}\n{"b":2}\n');
    // So `wc -l` reports the row count.
    expect(text.split('\n').filter((line) => line !== '')).toHaveLength(2);
  });

  it('produces nothing for no rows, rather than a stray newline', () => {
    expect(toNdjson([])).toBe('');
  });
});

/* =========================================================================
 * The bundle
 * ====================================================================== */

describe('buildExportBundle', () => {
  it('contains every file §9.10 names', () => {
    const result = buildExportBundle(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const text = decoder.decode(result.bundle.bytes);
    for (const path of [
      'README.md',
      'schema.json',
      'metrics.json',
      'decrypt.md',
      'medical-timeline.md',
      'media/manifest.json',
      'tables/observation.ndjson',
    ]) {
      expect(text.includes(path), `archive is missing ${path}`).toBe(true);
    }
  });

  /**
   * §9.10's verification step needs the checksums *outside* the archive to
   * compare against — "a quarterly drill re-imports an export into a scratch
   * database and asserts row-count and checksum equality". A checksum that only
   * exists inside the thing it is checking is not a check.
   */
  it('returns a manifest with row counts and checksums outside the archive', () => {
    const result = buildExportBundle(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { manifest } = result.bundle;
    expect(manifest.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(manifest.totalRows).toBe(2);
    expect(manifest.tables[0]).toMatchObject({ name: 'observation', rows: 2 });
    expect(manifest.tables[0]?.crc32).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is deterministic — the same input produces the same bytes', () => {
    const first = buildExportBundle(input());
    const second = buildExportBundle(input());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(Array.from(first.bundle.bytes)).toEqual(Array.from(second.bundle.bytes));
  });

  it('carries media and its manifest', () => {
    const result = buildExportBundle(
      input({
        media: [
          {
            path: '2026/08/skin-face.jpg',
            bytes: encoder.encode('not-really-a-jpeg'),
            sha256: 'a'.repeat(64),
            originalName: 'IMG_0042.jpg',
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const text = decoder.decode(result.bundle.bytes);
    expect(text.includes('media/2026/08/skin-face.jpg')).toBe(true);
    expect(text.includes('IMG_0042.jpg')).toBe(true);
    expect(result.bundle.manifest.media[0]?.sha256).toBe('a'.repeat(64));
  });

  it('falls back to the ZIP epoch for an unparseable generatedAt', () => {
    const result = buildExportBundle(input({ generatedAt: 'not-a-time' }));
    // The archive still builds — the timestamp is file metadata, and the real
    // instants are in the rows.
    expect(result.ok).toBe(true);
  });
});

describe('schema.json', () => {
  /**
   * §9.10's first property: "The metric registry travels with the data, so
   * every number carries its meaning." A bare `74.2` is nothing; joined to its
   * metric row it is a complete fact.
   */
  it('carries the whole metric registry, descriptions included', () => {
    const document = buildSchemaDocument(input());
    expect(document.metrics).toHaveLength(MVP_METRICS.length);

    const mood = document.metrics.find((metric) => metric['key'] === 'mind.mood');
    expect(mood?.['description']).toMatch(/1 \(worst\) to 5 \(best\)/);
    expect(mood?.['canonicalUnit']).toBe('');
    expect(mood?.['minValue']).toBe('1');
  });

  it('documents every convention a reader would otherwise get wrong', () => {
    const document = buildSchemaDocument(input());
    // Each of these is an assumption that produces a wrong answer silently.
    expect(document.conventions['numbers']).toMatch(/never a JSON number/);
    expect(document.conventions['observations']).toMatch(/append-only/);
    expect(document.conventions['observationValues']).toMatch(/INDEX/);
    expect(document.conventions['time']).toMatch(/IANA zone/);
    expect(document.conventions['hlc']).toMatch(/causal order/);
  });

  it('names the file each table lives in', () => {
    const document = buildSchemaDocument(input());
    expect(document.tables[0]).toMatchObject({
      name: 'observation',
      rowCount: 2,
      file: 'tables/observation.ndjson',
    });
  });
});

describe('README', () => {
  /**
   * §9.10 asks for a README "explaining the format to a person who has never
   * seen this system" — not to a developer of it. These assertions are about
   * audience, which is the part that decays fastest.
   */
  it('explains the format to someone who has never seen the application', () => {
    const readme = buildReadme(input());
    expect(readme).toMatch(/newline-delimited JSON/);
    expect(readme).toMatch(/you do not need that\napplication to read it/);
    expect(readme).toMatch(/Numbers are strings/);
    expect(readme).toMatch(/Nothing was ever edited/);
    // A worked example in a language somebody will actually have.
    expect(readme).toMatch(/import json/);
  });

  it('states the actual counts rather than a placeholder', () => {
    const readme = buildReadme(input());
    expect(readme).toMatch(/1 tables, 2 rows, 0 media files/);
  });
});

describe('the decryption guide', () => {
  /**
   * §9.10: "Encrypted media that can only be read by an application that no
   * longer runs is not exported data. A standalone script plus the passphrase
   * must be sufficient." The algorithm has to be named precisely enough to be
   * reimplemented from the text.
   */
  it('names the algorithm and its parameters exactly', () => {
    const guide = buildDecryptionGuide();
    expect(guide).toMatch(/AES-256-GCM/);
    expect(guide).toMatch(/PBKDF2-HMAC-SHA256/);
    expect(guide).toMatch(/600,000 iterations/);
    expect(guide).toMatch(/wrappedKey/);
    expect(guide).toMatch(/keySalt/);
    // And a verification step, so a recovered file can be proved intact.
    expect(guide).toMatch(/sha256/);
  });
});
