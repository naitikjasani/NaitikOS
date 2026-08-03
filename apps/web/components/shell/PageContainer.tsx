import type { ReactNode } from 'react';
import { Container, Inline, Stack, Text } from '@naitikos/design-system';

/**
 * Page-level composition.
 *
 * §6.2 keeps `app/` to routing only, so a page file renders a screen and a
 * screen renders this. The header is part of the container rather than a
 * separate component because a page without a title is never correct — §8.13
 * requires a document outline, and an `h1` per page is the top of it.
 */
export type PageContainerProps = {
  readonly title: string;
  readonly description?: string;
  /** Rendered opposite the title — a primary action, a filter. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  /** `reading` for long-form, `wide` for tables and charts (§8.4). */
  readonly width?: 'reading' | 'content' | 'wide' | 'full';
};

export function PageContainer({
  title,
  description,
  actions,
  children,
  width = 'content',
}: PageContainerProps): ReactNode {
  return (
    <Container width={width} className="page">
      <Stack gap="6">
        <Inline gap="4" align="start" justify="between" wrap>
          <Stack gap="1">
            {/*
              The page `h1`. Exactly one per page, and it is here rather than in
              the top bar — a breadcrumb trail is navigation, not a heading, and
              screen-reader users navigate by heading level.
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
          {actions !== undefined && <Inline gap="2">{actions}</Inline>}
        </Inline>

        {children}
      </Stack>
    </Container>
  );
}
