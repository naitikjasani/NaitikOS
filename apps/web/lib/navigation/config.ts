import type { IconName } from '@naitikos/design-system';

/**
 * The navigation structure, as data.
 *
 * §3.2 defines four surfaces and five pillars, and §3.1 explains why the shape
 * matters more than it looks:
 *
 *   "Sixteen top-level modules in a sidebar is how personal systems die. The
 *    user opens the app, sees fourteen mostly-empty sections, feels the weight
 *    of everything unmaintained, and closes it."
 *
 * ## `available` is doing real work
 *
 * §3.3 R6 is unambiguous: "`[V2]` and `[V3]` routes do not exist in the shipped
 * MVP. Not hidden, not disabled, not greyed out — **absent**. A visible-but-empty
 * module teaches the user that the system is a graveyard."
 *
 * So `available: false` means **the shell does not render it at all** in a
 * production build. The entries exist here because the navigation structure is
 * platform infrastructure that has to be designed once — but `visibleNavItems()`
 * filters them out, and the filter is the enforcement of R6.
 *
 * In development they render disabled, so the shell can be seen and tested
 * against its real shape rather than against a one-item list. That is a
 * developer affordance and it is gated on `NODE_ENV`.
 */

export type NavItem = {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly icon: IconName;
  /**
   * Whether the route exists.
   *
   * `false` means the route does not exist yet, and the shell omits it
   * entirely in production rather than rendering it disabled (§3.3 R6).
   */
  readonly available: boolean;
  /** Roadmap phase, for the development-only affordance. */
  readonly phase?: 'mvp' | 'v2' | 'v3';
};

/**
 * The primary surfaces (§3.2).
 *
 * Deliberately five entries, not sixteen. Pillars are navigational groupings;
 * features are implementation units, and §7.5 notes the feature list is longer
 * than this one on purpose.
 */
export const PRIMARY_NAV: readonly NavItem[] = Object.freeze([
  {
    id: 'today',
    label: 'Today',
    href: '/today',
    icon: 'nav.today',
    // §3.2: "Default route is /today. There is no home page distinct from Today."
    available: true,
    phase: 'mvp',
  },
  {
    id: 'body',
    label: 'Body',
    href: '/body',
    icon: 'nav.body',
    // `/body`, `/body/gym` and its four views, `/body/composition`, and from
    // week four `/body/skin` and its four. Sleep has no module of its own in the
    // MVP — it is two Daily Close fields (§4.6) — so there is no `/body/sleep`
    // route and §3.3 R6 keeps it absent rather than empty.
    available: true,
    phase: 'mvp',
  },
  {
    id: 'mind',
    label: 'Mind',
    href: '/mind',
    icon: 'nav.mind',
    // Available from week four: the overview, anxiety, journal, practices and
    // the medication lens.
    available: true,
    phase: 'mvp',
  },
  {
    id: 'timeline',
    label: 'Timeline',
    href: '/timeline',
    icon: 'nav.timeline',
    // Available from the ritual milestone: the route exists and renders the
    // event projection. It has nothing to show until a day is closed, which is
    // an empty state rather than a missing page.
    available: true,
    phase: 'mvp',
  },
  {
    id: 'life',
    label: 'Life',
    href: '/life',
    icon: 'nav.life',
    // Available from the Health core milestone, and holding exactly one module:
    // the document vault. Goals and Reviews stay absent under §3.3 R6 rather
    // than appearing as empty rooms.
    available: true,
    phase: 'v2',
  },
  {
    id: 'library',
    label: 'Library',
    href: '/library',
    icon: 'nav.library',
    available: false,
    phase: 'mvp',
  },
]);

/**
 * Items shown in the mobile tab bar.
 *
 * Capped at four. A fifth tab makes each target narrower than the 44px §8.13
 * requires on a 360px screen, and the thumb cannot reliably hit them. Settings
 * lives in the profile menu on mobile rather than taking a tab.
 */
export const MOBILE_NAV_LIMIT = 4;

/**
 * Filter to what actually exists.
 *
 * The implementation of §3.3 R6. In production, unavailable routes are absent;
 * in development they are returned so the shell renders at full shape.
 */
export function visibleNavItems(includeUnavailable = false): readonly NavItem[] {
  if (includeUnavailable) return PRIMARY_NAV;
  return PRIMARY_NAV.filter((item) => item.available);
}

/** Whether the development affordance is active. */
export function showsUnbuiltRoutes(): boolean {
  return process.env['NODE_ENV'] !== 'production';
}

/**
 * Which nav item a pathname belongs to.
 *
 * Prefix-matched so `/body/skin/photos` highlights Body. Exact-matched for
 * `/today`, because a prefix match on a one-segment route would also claim
 * `/todays-something`.
 */
export function activeNavId(pathname: string): string | null {
  for (const item of PRIMARY_NAV) {
    if (pathname === item.href) return item.id;
    if (pathname.startsWith(`${item.href}/`)) return item.id;
  }
  return null;
}

/**
 * Breadcrumbs for a pathname.
 *
 * §3.3 caps depth at three, so these are short by construction. The first
 * segment is resolved through the nav config to get its proper label; deeper
 * segments are title-cased, which is correct for the route vocabulary in §3.2
 * (`photos`, `exercises`, `medications`) and is replaced by a real label when a
 * feature supplies one.
 */
export function breadcrumbsFor(pathname: string): readonly { label: string; href?: string }[] {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return [];

  const crumbs: { label: string; href?: string }[] = [];
  let href = '';

  for (const [index, segment] of segments.entries()) {
    href += `/${segment}`;
    const known = PRIMARY_NAV.find((item) => item.href === href);
    const isLast = index === segments.length - 1;

    crumbs.push({
      label: known?.label ?? titleCase(segment),
      // The final crumb is the current page and carries no href — linking the
      // page you are on is a small lie screen-reader users notice.
      ...(isLast ? {} : { href }),
    });
  }

  return crumbs;
}

function titleCase(segment: string): string {
  return segment
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
