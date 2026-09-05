'use client';

import type { ReactNode } from 'react';
import { DENSITIES, MOTION_PREFERENCES, THEMES } from '@naitikos/core';
import type { Density, MotionPreference, Theme } from '@naitikos/core';
import { Badge, Button, Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

import { useAppearanceStore } from '@/lib/stores/appearance.store';

/**
 * `/settings/appearance` — §3.2's "Theme, density, motion".
 *
 * ## All three of these controls are real
 *
 * `AppearanceProvider` stamps `data-theme`, `data-density` and `data-motion` on
 * the document root, and the token layer reads all three: `[data-theme='light']`
 * and `[data-density='compact']` in `tokens.css`, `[data-motion='reduced']` in
 * `base.css`. Nothing here is decorative — §8.6 requires the motion decision to
 * be made exactly once at the provider level, and this is the surface that
 * makes it.
 *
 * ## Why this is a client component, and why it saves nothing
 *
 * Appearance is device-local by design. `appearance.store.ts` states the
 * direction of authority: the browser holds the applied value in `localStorage`
 * because theme must apply *before first paint* — a server round trip means a
 * flash of the wrong theme on every load, which on a tool opened in a dark
 * bedroom is not cosmetic.
 *
 * The consequence is stated on the page rather than hidden: `Preferences` in
 * core carries `theme`, `density` and `motion`, and **nothing writes them**.
 * `/api/settings` accepts `kind: 'ai'` only, and `AppearanceProvider` is mounted
 * in `app/layout.tsx` without `serverValues`. So these choices do not follow the
 * operator to a second device, and a page that implied otherwise would be
 * lying about its own persistence.
 *
 * ## Buttons rather than a select
 *
 * Three options each. A listbox for three values costs a tap to open and hides
 * two of the three, and §8.13's 44px target is easier to hit on a row of
 * buttons than in a native picker on a 360px screen.
 */

export function AppearanceSettingsScreen(): ReactNode {
  const theme = useAppearanceStore((state) => state.theme);
  const setTheme = useAppearanceStore((state) => state.setTheme);
  const density = useAppearanceStore((state) => state.density);
  const setDensity = useAppearanceStore((state) => state.setDensity);
  const motion = useAppearanceStore((state) => state.motion);
  const setMotion = useAppearanceStore((state) => state.setMotion);

  return (
    <Stack gap="5">
      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Text role="title-3" as="h2">
              Theme
            </Text>
            <OptionRow
              groupLabel="Theme"
              value={theme}
              onSelect={setTheme}
              options={THEMES.map((value) => ({ value, label: themeLabel(value) }))}
            />
            {/* §8.7, quoted rather than paraphrased: this is a decision, not a taste. */}
            <Text role="caption" tone="tertiary">
              Dark is the default. §8.7: the application is opened last thing at night for the Daily Close
              and in a dimly lit gym, and defaulting to light is optimising for the wrong context. System
              follows the operating system.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Text role="title-3" as="h2">
              Density
            </Text>
            <OptionRow
              groupLabel="Density"
              value={density}
              onSelect={setDensity}
              options={DENSITIES.map((value) => ({ value, label: densityLabel(value) }))}
            />
            <Text role="caption" tone="tertiary">
              Compact tightens the gutter, section gap, card padding, control height and row height. It
              changes spacing tokens only — no type size, and no touch target below §8.13&rsquo;s minimum.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Text role="title-3" as="h2">
              Motion
            </Text>
            <OptionRow
              groupLabel="Motion"
              value={motion}
              onSelect={setMotion}
              options={MOTION_PREFERENCES.map((value) => ({ value, label: motionLabel(value) }))}
            />
            {/*
              Why an explicit setting exists at all when the OS already has one:
              §4.7's duty of care. Vestibular sensitivity and anxiety are not the
              same thing, and turning animation off here should not require
              changing it for the whole device.
            */}
            <Text role="caption" tone="tertiary">
              Reduced collapses every transition and animation to zero duration. System follows
              <code> prefers-reduced-motion</code>. Full overrides the device setting — choose it only
              deliberately, because it defeats an accessibility preference you may have set elsewhere.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="2">
            <Inline gap="2" align="center">
              <Text role="title-3" as="h2">
                Where these are stored
              </Text>
              <Badge tone="caution">this device only</Badge>
            </Inline>
            <Text role="body-sm" tone="secondary">
              All three are held in this browser&rsquo;s local storage and applied before the first paint,
              so there is no flash of the wrong theme on load. They are not written to the server, so they
              do not follow you to another device and clearing site data resets them to dark, comfortable,
              system.
            </Text>
            <Text role="caption" tone="tertiary">
              The <code>setting</code> row has fields for all three and nothing writes them yet. When
              something does, the server row becomes the record and this store becomes its cache — the
              direction of authority is already fixed in <code>appearance.store.ts</code>.
            </Text>
          </Stack>
        </CardBody>
      </Card>
    </Stack>
  );
}

/**
 * A row of mutually exclusive choices.
 *
 * `aria-pressed` rather than `role="radiogroup"`: these apply on press with no
 * confirmation step, which is toggle-button semantics. A radio group implies a
 * pending selection that a later action commits, and there is no such action.
 */
function OptionRow<T extends string>({
  groupLabel,
  options,
  value,
  onSelect,
}: {
  readonly groupLabel: string;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly onSelect: (value: T) => void;
}): ReactNode {
  return (
    // A plain element, because `Inline` forwards no ARIA attributes. The group
    // name has to reach a screen reader from somewhere, and a wrapper is
    // cheaper than widening a layout primitive's prop surface.
    <div role="group" aria-label={groupLabel}>
      <Inline gap="2" wrap>
        {options.map((option) => (
          <Button
            key={option.value}
            size="sm"
            variant={option.value === value ? 'primary' : 'secondary'}
            aria-pressed={option.value === value}
            onClick={() => {
              onSelect(option.value);
            }}
          >
            {option.label}
          </Button>
        ))}
      </Inline>
    </div>
  );
}

function themeLabel(theme: Theme): string {
  if (theme === 'dark') return 'Dark';
  if (theme === 'light') return 'Light';
  return 'System';
}

function densityLabel(density: Density): string {
  return density === 'comfortable' ? 'Comfortable' : 'Compact';
}

function motionLabel(motion: MotionPreference): string {
  if (motion === 'full') return 'Full';
  if (motion === 'reduced') return 'Reduced';
  return 'System';
}
