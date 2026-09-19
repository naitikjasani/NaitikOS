'use client';

import { usePathname } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { Divider, Icon, IconButton, Text, cn } from '@naitikos/design-system';

import { useNavigationStore } from '@/lib/stores/navigation.store';
import { NAV_SECTIONS, navTrail, type NavNode } from './navigation-tree';
import { NavLink, type NavLinkState } from './NavLink';

/**
 * The desktop sidebar.
 *
 * Hidden below `lg` in CSS rather than unmounted, so crossing the breakpoint
 * costs no re-render and no layout shift.
 *
 * ## What it renders, and why it is not the whole tree
 *
 * §3.2 defines roughly ninety static routes. Rendering them all would be the
 * exact failure §3.1 describes — "sees fourteen mostly-empty sections, feels
 * the weight of everything unmaintained, and closes it" — with the weight
 * multiplied by six.
 *
 * So the rail renders the eleven surfaces always, and exactly one pillar's
 * interior: the one the operator is currently inside. Everything else is one
 * disclosure away, and the whole tree is one ⌘K away. The cost of a route being
 * one interaction distant is small; the cost of ninety rows of other people's
 * unfinished business is that the app stops getting opened.
 *
 * ## Three levels of position
 *
 * On `/body/gym/programs/abc123` the rail shows Body as a branch, Gym expanded
 * beneath it, and Programs marked current. That is the answer to "where am I",
 * and without it a third-level route is indistinguishable from the pillar
 * overview in the navigation.
 *
 * Collapsing hides the labels and narrows the rail. The icons keep their
 * accessible names through `NavLink`'s text, so a collapsed sidebar is still
 * fully navigable by screen reader — §8.5's rule that an icon is never the sole
 * carrier of meaning applies to the collapsed state too.
 */
export function Sidebar(): ReactNode {
  const pathname = usePathname();
  const isCollapsed = useNavigationStore((state) => state.isSidebarCollapsed);
  const toggleSidebar = useNavigationStore((state) => state.toggleSidebar);

  const trail = useMemo(() => navTrail(pathname), [pathname]);
  const onTrail = useMemo(() => new Set(trail.hrefs), [trail]);

  return (
    <nav
      className={cn('sidebar', isCollapsed && 'is-collapsed')}
      aria-label="Primary"
      data-collapsed={isCollapsed}
      // Read by AppShell's focus management: focus sitting inside a navigation
      // region is focus the operator has just spent, and is safe to move.
      data-shell-nav
    >
      <div className="sidebar__brand">
        {!isCollapsed && (
          <Text role="title-3" as="p">
            Ekayu
          </Text>
        )}
        <IconButton
          icon={isCollapsed ? 'nav.forward' : 'nav.back'}
          label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          size="sm"
          onClick={toggleSidebar}
        />
      </div>

      <Divider />

      {/*
        The scroller is this element rather than the whole rail, so the brand
        and its collapse control stay put. `overscroll-behavior: contain` in CSS
        stops a flick at the end of a long pillar from scrolling the page behind
        it, which reads as the navigation throwing the operator out of place.
      */}
      <div className="sidebar__scroll">
        {NAV_SECTIONS.map((section) => {
          const headingId = `sidebar-section-${section.id}`;
          return (
            <div className="sidebar__section" key={section.id}>
              {/*
                A real heading, and kept in the accessibility tree even when the
                rail is collapsed — a screen-reader user navigating by heading
                should not lose the surface/pillar distinction (§3.1) just
                because a sighted user reclaimed 150px.
              */}
              <Text
                role="caption"
                tone="tertiary"
                as="h2"
                id={headingId}
                className={cn('sidebar__section-heading', isCollapsed && 'nos-visually-hidden')}
              >
                {section.label}
              </Text>
              <ul className="sidebar__list" aria-labelledby={headingId}>
                {section.items.map((item) => (
                  <SidebarNode
                    key={item.href}
                    node={item}
                    depth={0}
                    onTrail={onTrail}
                    currentHref={trail.currentHref}
                    isCollapsed={isCollapsed}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}

function stateFor(
  href: string,
  currentHref: string | null,
  onTrail: ReadonlySet<string>,
): NavLinkState {
  if (href === currentHref) return 'current';
  return onTrail.has(href) ? 'branch' : 'idle';
}

/**
 * One row, plus its subtree when that subtree is relevant.
 *
 * Disclosure is only offered at depth 0. Two reasons: a chevron at every level
 * puts three of them in a 15rem rail, and §3.3 R1 caps depth at three anyway,
 * so the deepest list is always reachable by opening one thing. Below depth 0
 * the subtree follows the route and nothing else.
 */
function SidebarNode({
  node,
  depth,
  onTrail,
  currentHref,
  isCollapsed,
}: {
  readonly node: NavNode;
  readonly depth: number;
  readonly onTrail: ReadonlySet<string>;
  readonly currentHref: string | null;
  readonly isCollapsed: boolean;
}): ReactNode {
  const override = useNavigationStore((state) => state.navGroupOverrides[node.href]);
  const toggleNavGroup = useNavigationStore((state) => state.toggleNavGroup);

  const children = node.children ?? [];
  const isOpenByRoute = onTrail.has(node.href);
  const isTopLevel = depth === 0;
  const canDisclose = isTopLevel && children.length > 0 && !isCollapsed;
  const isOpen = children.length > 0 && !isCollapsed && (isTopLevel ? (override ?? isOpenByRoute) : isOpenByRoute);

  // Derived from the href rather than `useId`, so the value is identical on the
  // server and the client and survives the rail being collapsed and reopened.
  const panelId = `sidebar-panel${node.href.replaceAll('/', '-')}`;

  return (
    <li className={cn('sidebar__node', isOpen && 'is-open')}>
      <div className="sidebar__row">
        <NavLink
          href={node.href}
          label={node.label}
          icon={node.icon}
          variant={isTopLevel ? 'sidebar' : 'subnav'}
          state={stateFor(node.href, currentHref, onTrail)}
        />
        {canDisclose && (
          <button
            type="button"
            className="sidebar__disclosure"
            aria-expanded={isOpen}
            aria-controls={panelId}
            onClick={() => {
              toggleNavGroup(node.href, isOpenByRoute);
            }}
          >
            {/*
              The label names the target, not the icon. "Expand" alone in a list
              of eleven identical chevrons tells a screen-reader user nothing
              about which one they are on.
            */}
            <span className="nos-visually-hidden">
              {isOpen ? `Collapse ${node.label}` : `Expand ${node.label}`}
            </span>
            <Icon name={isOpen ? 'nav.collapse' : 'nav.expand'} label={null} size="sm" />
          </button>
        )}
      </div>

      {isOpen && (
        <ul id={panelId} className="sidebar__sublist" data-depth={depth + 1}>
          {children.map((child) => (
            <SidebarNode
              key={child.href}
              node={child}
              depth={depth + 1}
              onTrail={onTrail}
              currentHref={currentHref}
              isCollapsed={isCollapsed}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
