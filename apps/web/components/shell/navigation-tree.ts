import type { IconName } from '@naitikos/design-system';

/**
 * The full §3.2 route hierarchy, as data.
 *
 * ## Why this exists next to `lib/navigation/config`
 *
 * `config` holds the eight primary surfaces — the list the mobile tab bar and
 * the pillar row are drawn from. It stops there deliberately: it is the
 * *product's* navigation contract.
 *
 * This file is the *shell's* index of every destination underneath those
 * surfaces. §3.2 defines roughly ninety static routes across sixteen domains,
 * and §3.1 names the failure they produce if the shell does not organise them:
 *
 *   "Sixteen top-level modules in a sidebar is how personal systems die."
 *
 * The organising response is that the sidebar shows one pillar's interior at a
 * time and the palette indexes all of them. Both need the same tree, so it is
 * written once, here, and both read it.
 *
 * ## Depth
 *
 * §3.3 R1 caps route depth at three, so this tree is three levels deep and no
 * deeper. A fourth level would be a query parameter or a modal; if one ever
 * appears here, R1 has been broken somewhere upstream.
 *
 * ## Absence rather than emptiness
 *
 * §3.3 R6: `[V2]`/`[V3]` routes "do not exist in the shipped MVP. Not hidden,
 * not disabled, not greyed out — absent." Every entry below corresponds to a
 * `page.tsx` that exists, so the rule is satisfied by construction rather than
 * by a filter. A route added here without a page is a dead link in the palette,
 * which is worse than an absent one.
 */

export type NavNode = {
  readonly href: string;
  readonly label: string;
  /** Present on top-level entries only — §8.5 gives sub-items their text alone. */
  readonly icon?: IconName;
  readonly children?: readonly NavNode[];
};

export type NavSection = {
  readonly id: string;
  /** Rendered as a group heading in the sidebar and as a palette group prefix. */
  readonly label: string;
  readonly items: readonly NavNode[];
};

/**
 * The sections are §3.1's surfaces, not an alphabetical list.
 *
 * §3.1 distinguishes *surfaces* (modes of engagement) from *pillars* (lenses
 * over one substrate), and the sidebar is the only place a person ever sees
 * that distinction made explicit. Grouping Body beside Timeline would flatten
 * it back into "sixteen modules", which is the shape §3.1 exists to avoid.
 */
export const NAV_SECTIONS: readonly NavSection[] = Object.freeze([
  {
    id: 'now',
    label: 'Now',
    items: [
      {
        href: '/today',
        label: 'Today',
        icon: 'nav.today',
        children: [{ href: '/today/close', label: 'Daily close' }],
      },
    ],
  },
  {
    id: 'pillars',
    label: 'Pillars',
    items: [
      {
        href: '/body',
        label: 'Body',
        icon: 'nav.body',
        children: [
          {
            href: '/body/gym',
            label: 'Gym',
            children: [
              { href: '/body/gym/log', label: 'Log a session' },
              { href: '/body/gym/history', label: 'History' },
              { href: '/body/gym/exercises', label: 'Exercises' },
              { href: '/body/gym/programs', label: 'Programs' },
              { href: '/body/gym/volume', label: 'Volume' },
            ],
          },
          {
            href: '/body/nutrition',
            label: 'Nutrition',
            children: [
              { href: '/body/nutrition/log', label: "Today's intake" },
              { href: '/body/nutrition/foods', label: 'Foods' },
              { href: '/body/nutrition/meals', label: 'Meals' },
              { href: '/body/nutrition/targets', label: 'Targets' },
              { href: '/body/nutrition/trends', label: 'Trends' },
            ],
          },
          {
            href: '/body/composition',
            label: 'Composition',
            children: [{ href: '/body/composition/photos', label: 'Photos' }],
          },
          {
            href: '/body/skin',
            label: 'Skin',
            children: [
              { href: '/body/skin/state', label: 'Daily log' },
              { href: '/body/skin/photos', label: 'Photos' },
              { href: '/body/skin/routine', label: 'Routine' },
              { href: '/body/skin/products', label: 'Products' },
              { href: '/body/skin/regions', label: 'Regions' },
              { href: '/body/skin/treatments', label: 'Treatments' },
            ],
          },
          {
            href: '/body/health',
            label: 'Health',
            children: [
              { href: '/body/health/vitals', label: 'Vitals' },
              { href: '/body/health/labs', label: 'Labs' },
              { href: '/body/health/conditions', label: 'Conditions' },
              { href: '/body/health/medications', label: 'Medications' },
              { href: '/body/health/appointments', label: 'Appointments' },
              { href: '/body/health/symptoms', label: 'Symptoms' },
              { href: '/body/health/pack', label: 'Consultation pack' },
            ],
          },
          {
            href: '/body/teeth',
            label: 'Teeth',
            children: [
              { href: '/body/teeth/procedures', label: 'Procedures' },
              { href: '/body/teeth/hygiene', label: 'Hygiene' },
              { href: '/body/teeth/appointments', label: 'Appointments' },
            ],
          },
          { href: '/body/sleep', label: 'Sleep' },
          { href: '/body/devices', label: 'Devices' },
          { href: '/body/appearance', label: 'Appearance' },
        ],
      },
      {
        href: '/mind',
        label: 'Mind',
        icon: 'nav.mind',
        children: [
          { href: '/mind/mood', label: 'Mood' },
          { href: '/mind/anxiety', label: 'Anxiety' },
          {
            href: '/mind/journal',
            label: 'Journal',
            children: [{ href: '/mind/journal/prompts', label: 'Prompts' }],
          },
          { href: '/mind/therapy', label: 'Therapy' },
          { href: '/mind/practices', label: 'Practices' },
          // §3.3 R3's canonical cross-cutting entity: one row, three lenses.
          // It is listed under Mind *and* under Body/Health on purpose.
          { href: '/mind/meds', label: 'Medication lens' },
        ],
      },
      {
        href: '/life',
        label: 'Life',
        icon: 'nav.life',
        children: [
          {
            href: '/life/goals',
            label: 'Goals',
            children: [{ href: '/life/goals/review', label: 'Goal review' }],
          },
          { href: '/life/reviews', label: 'Reviews' },
          { href: '/life/documents', label: 'Documents' },
          { href: '/life/people', label: 'People' },
          { href: '/life/places', label: 'Places' },
        ],
      },
      {
        href: '/work',
        label: 'Work',
        icon: 'nav.work',
        children: [
          { href: '/work/tasks', label: 'Tasks' },
          { href: '/work/projects', label: 'Projects' },
          { href: '/work/career', label: 'Career' },
          {
            href: '/work/learning',
            label: 'Learning',
            children: [
              { href: '/work/learning/queue', label: 'Queue' },
              { href: '/work/learning/notes', label: 'Notes' },
            ],
          },
          { href: '/work/calendar', label: 'Calendar' },
          { href: '/work/focus', label: 'Focus' },
        ],
      },
      {
        href: '/money',
        label: 'Money',
        icon: 'nav.money',
        children: [
          { href: '/money/accounts', label: 'Accounts' },
          { href: '/money/transactions', label: 'Transactions' },
          { href: '/money/budgets', label: 'Budgets' },
          { href: '/money/subscriptions', label: 'Subscriptions' },
          { href: '/money/shopping', label: 'Shopping' },
          { href: '/money/networth', label: 'Net worth' },
        ],
      },
    ],
  },
  {
    id: 'explore',
    label: 'Explore',
    items: [
      {
        href: '/timeline',
        label: 'Timeline',
        icon: 'nav.timeline',
        children: [
          { href: '/timeline/life', label: 'Life view' },
          {
            href: '/timeline/medical',
            label: 'Medical',
            children: [{ href: '/timeline/medical/pack', label: 'Consultation pack' }],
          },
        ],
      },
      { href: '/ask', label: 'Ask', icon: 'action.search' },
      {
        href: '/insights',
        label: 'Insights',
        icon: 'domain.streak',
        children: [
          { href: '/insights/archive', label: 'Archive' },
          { href: '/insights/calibration', label: 'Calibration' },
        ],
      },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      {
        href: '/library',
        label: 'Library',
        icon: 'nav.library',
        children: [
          { href: '/library/exercises', label: 'Exercises' },
          { href: '/library/foods', label: 'Foods' },
          { href: '/library/products', label: 'Products' },
          { href: '/library/protocols', label: 'Protocols' },
          { href: '/library/metrics', label: 'Metrics' },
          { href: '/library/tags', label: 'Tags' },
        ],
      },
      {
        href: '/settings',
        label: 'Settings',
        icon: 'nav.settings',
        children: [
          { href: '/settings/profile', label: 'Profile' },
          { href: '/settings/appearance', label: 'Appearance' },
          { href: '/settings/capture', label: 'Capture rail' },
          { href: '/settings/notifications', label: 'Notifications' },
          { href: '/settings/integrations', label: 'Integrations' },
          { href: '/settings/ai', label: 'AI & consent' },
          { href: '/settings/privacy', label: 'Privacy' },
          {
            href: '/settings/data',
            label: 'Data',
            children: [
              { href: '/settings/data/export', label: 'Export' },
              { href: '/settings/data/audit', label: 'Audit log' },
            ],
          },
          { href: '/settings/developer', label: 'Developer' },
        ],
      },
    ],
  },
]);

/**
 * Whether a pathname sits at or beneath a node.
 *
 * The `/` suffix on the prefix test is what stops `/today` from claiming
 * `/todays-something`, and — less obviously — stops `/body/gym` from claiming a
 * future `/body/gymnastics`. Prefix matching without it is the classic
 * highlight-two-things-at-once bug.
 */
function covers(nodeHref: string, pathname: string): boolean {
  return pathname === nodeHref || pathname.startsWith(`${nodeHref}/`);
}

export type NavTrail = {
  /** Every ancestor href from the surface down to, and including, the deepest match. */
  readonly hrefs: readonly string[];
  /** The deepest node that covers the pathname, or `null` off-tree. */
  readonly currentHref: string | null;
};

/**
 * Where the operator is, expressed as a path through the tree.
 *
 * The sidebar needs three distinct answers at once — which surface, which
 * module, which view — because a route like `/body/gym/programs/[id]` is
 * otherwise indistinguishable from `/body` in the navigation. Returning the
 * whole chain rather than a single id is what lets the sidebar show all three.
 *
 * `currentHref` is the *deepest* covering node, not the exact match: on
 * `/body/gym/programs/abc123` the programs list is the right thing to mark,
 * because the detail page has no entry of its own and never will (§3.3 R1).
 */
export function navTrail(pathname: string): NavTrail {
  const hrefs: string[] = [];

  const walk = (nodes: readonly NavNode[]): void => {
    for (const node of nodes) {
      if (!covers(node.href, pathname)) continue;
      hrefs.push(node.href);
      if (node.children !== undefined) walk(node.children);
      return;
    }
  };

  for (const section of NAV_SECTIONS) walk(section.items);

  return { hrefs, currentHref: hrefs.at(-1) ?? null };
}

export type Destination = {
  readonly href: string;
  readonly label: string;
  /**
   * The top-level surface this destination belongs to — the palette's group
   * heading.
   *
   * The surface rather than the §3.1 section, because "Body" is how a person
   * looks for `/body/skin/products` and "Pillars" is not.
   */
  readonly group: string;
  readonly icon: IconName;
  /** Ancestor labels, e.g. `['Body', 'Gym']`. Shown as a path, and searched. */
  readonly trail: readonly string[];
};

function flatten(
  nodes: readonly NavNode[],
  group: string,
  icon: IconName,
  trail: readonly string[],
  into: Destination[],
): void {
  for (const node of nodes) {
    into.push({ href: node.href, label: node.label, group, icon, trail });
    if (node.children !== undefined) {
      flatten(node.children, group, icon, [...trail, node.label], into);
    }
  }
}

/**
 * Every destination in the application, flat.
 *
 * The command palette's index. Computed once at module scope rather than per
 * render: it is derived from a frozen constant, so recomputing it on every
 * keystroke in a ninety-item list would be pure waste.
 *
 * The `trail` is carried through because labels collide badly at this size —
 * there are three distinct "Photos", two "Appointments", and two "Exercises".
 * A palette that renders only the leaf label makes those a coin flip.
 */
export const DESTINATIONS: readonly Destination[] = Object.freeze(
  NAV_SECTIONS.flatMap((section) =>
    section.items.flatMap((item) => {
      const icon: IconName = item.icon ?? 'nav.more';
      const rows: Destination[] = [
        { href: item.href, label: item.label, group: item.label, icon, trail: [] },
      ];
      if (item.children !== undefined) {
        flatten(item.children, item.label, icon, [item.label], rows);
      }
      return rows;
    }),
  ),
);

/**
 * The same index, grouped by surface, in tree order.
 *
 * The palette renders groups rather than one flat list because ninety
 * undifferentiated rows is a list nobody scans — and because the group heading
 * is what disambiguates the four "Photos" and three "Appointments" when the
 * operator is skimming rather than reading.
 */
export const DESTINATION_GROUPS: readonly {
  readonly label: string;
  readonly items: readonly Destination[];
}[] = Object.freeze(
  NAV_SECTIONS.flatMap((section) =>
    section.items.map((item) => ({
      label: item.label,
      items: DESTINATIONS.filter((destination) => destination.group === item.label),
    })),
  ),
);

const LABELS_BY_HREF: ReadonlyMap<string, string> = new Map(
  DESTINATIONS.map((destination) => [destination.href, destination.label]),
);

export function destinationFor(href: string): Destination | undefined {
  return DESTINATIONS.find((destination) => destination.href === href);
}

/**
 * The ancestor trail for a pathname, as breadcrumb data.
 *
 * The current page is deliberately *not* included. Its true name is the page's
 * own `h1`, and the caller appends that — which matters on the dynamic routes
 * §3.2 is full of, where the final segment is an opaque id. Title-casing a UUID
 * into "A3f2b19c" is worse than no crumb at all.
 */
export function ancestorCrumbs(pathname: string): readonly { label: string; href: string }[] {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  const crumbs: { label: string; href: string }[] = [];
  let href = '';

  // The last segment is the current page; the caller names it.
  for (const segment of segments.slice(0, -1)) {
    href += `/${segment}`;
    crumbs.push({ label: LABELS_BY_HREF.get(href) ?? titleCase(segment), href });
  }

  return crumbs;
}

function titleCase(segment: string): string {
  return segment
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
