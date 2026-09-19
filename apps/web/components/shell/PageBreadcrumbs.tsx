'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { Breadcrumbs } from '@naitikos/design-system';

import { ancestorCrumbs } from './navigation-tree';

/**
 * The trail above a page title.
 *
 * ## Why it lives with the page and not in the top bar
 *
 * It used to be in the top bar, hidden below `md`, on the argument that "on a
 * phone the page title carries the context". That argument holds for
 * `/body/gym` and fails completely for `/body/gym/programs/abc123`, where the
 * title is a program's name and nothing on screen says which pillar it belongs
 * to or offers a way back up. §3.3 R1 caps depth at three precisely so that a
 * trail is short enough to always show — so it is always shown, at every width,
 * where the heading it qualifies actually is.
 *
 * Moving it also gives the top bar back to things that are true on every route
 * (search, account, navigation progress) rather than things that change per
 * page.
 *
 * ## The current page is named by its `h1`, not by its URL
 *
 * `ancestorCrumbs` deliberately stops short of the final segment and the
 * caller appends the page's real title. The alternative — title-casing the last
 * path segment — produces "Abc123" on every detail route in §3.2, and there are
 * a lot of them.
 *
 * This is the only client component in the page header. `PageContainer` stays a
 * Server Component; the pathname dependency is pushed exactly this far down.
 */
export function PageBreadcrumbs({ title }: { readonly title: string }): ReactNode {
  const pathname = usePathname();
  const crumbs = useMemo(() => {
    const ancestors = ancestorCrumbs(pathname);
    if (ancestors.length === 0) return [];
    return [...ancestors, { label: title }];
  }, [pathname, title]);

  if (crumbs.length === 0) return null;

  return (
    <Breadcrumbs
      crumbs={crumbs}
      className="page__crumbs"
      // Injected so the design system never imports a router (§6.2).
      renderLink={(href, children) => <Link href={href}>{children}</Link>}
    />
  );
}
