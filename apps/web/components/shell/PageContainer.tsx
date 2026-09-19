import type { ReactNode } from 'react';
import { Container, Inline, Stack, Text } from '@naitikos/design-system';

import { PageBreadcrumbs } from './PageBreadcrumbs';

/**
 * Page-level composition.
 *
 * §6.2 keeps `app/` to routing only, so a page file renders a screen and a
 * screen renders this. The header is part of the container rather than a
 * separate component because a page without a title is never correct — §8.13
 * requires a document outline, and an `h1` per page is the top of it.
 *
 * The header carries four things, in the order a person reads them: where this
 * page sits (breadcrumbs), what it is (the `h1`), what it is for (the
 * description), and the one thing you most likely came to do (actions). Sixteen
 * domains and ninety routes is enough that a page arriving with only a title is
 * a page the operator has to orient themselves inside.
 */
export type PageContainerProps = {
  readonly title: string;
  readonly description?: string;
  /** Rendered opposite the title — a primary action, a filter. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  /** `reading` for long-form, `wide` for tables and charts (§8.4). */
  readonly width?: 'reading' | 'content' | 'wide' | 'full';
  /**
   * Suppress the breadcrumb trail.
   *
   * For the handful of screens that are their own root — a full-page Daily
   * Close, an error boundary — where a trail back into the app is either
   * meaningless or an invitation to abandon a ritual mid-way.
   */
  readonly breadcrumbs?: boolean;
};

export function PageContainer({
  title,
  description,
  actions,
  children,
  width = 'content',
  breadcrumbs = true,
}: PageContainerProps): ReactNode {
  return (
    <Container width={width} className="page">
      <Stack gap="6">
        <Stack gap="2">
          {breadcrumbs && <PageBreadcrumbs title={title} />}

          <Inline gap="4" align="start" justify="between" wrap>
            <Stack gap="1">
              {/*
                The page `h1`. Exactly one per page, and it is here rather than
                in the top bar — a breadcrumb trail is navigation, not a
                heading, and screen-reader users navigate by heading level.
              */}
              <Text role="title-1" as="h1">
                {title}
              </Text>
              {description !== undefined && (
                <Text role="body" tone="secondary">
                  {description}
                </Text>
              )}
            </Stack>
            {/*
              Wraps under the title on a narrow screen rather than squeezing it,
              because a truncated `h1` costs more than a second row does.
            */}
            {actions !== undefined && (
              <Inline gap="2" className="page__actions">
                {actions}
              </Inline>
            )}
          </Inline>
        </Stack>

        {children}
      </Stack>
    </Container>
  );
}
