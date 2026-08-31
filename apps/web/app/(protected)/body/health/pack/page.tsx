/**
 * `/body/health/pack` → `/timeline/medical/pack`.
 *
 * The pack shipped here and §3.2 puts it under the medical timeline, where
 * §10.7 introduces it. A redirect rather than a deletion: the old path may sit
 * in a browser history, and a 404 on the morning of a consultation is the worst
 * possible time to discover a route moved.
 *
 * `permanentRedirect`, so the history entry is replaced rather than
 * accumulating a hop that outlives this file.
 */

import { permanentRedirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function MovedConsultationPackPage(): never {
  permanentRedirect('/timeline/medical/pack');
}
