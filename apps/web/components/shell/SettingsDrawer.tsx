'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Divider,
  SegmentedControl,
  Sheet,
  Stack,
  Text,
} from '@naitikos/design-system';
import { DENSITIES, MOTION_PREFERENCES, THEMES } from '@naitikos/core';

import { useAppearanceStore } from '@/lib/stores/appearance.store';
import { useNavigationStore } from '@/lib/stores/navigation.store';

/**
 * The settings drawer.
 *
 * A sheet rather than a route, for the reason §8.12 gives: a sheet is for
 * "contextual detail or capture", and appearance settings are changed *while
 * looking at* the thing they affect. A `/settings/appearance` page would hide
 * the subject of the change behind the control.
 *
 * §3.2 does define a full `/settings` route tree — that is where the settings
 * that are not appearance will live (export, integrations, consent scopes). This
 * drawer is the appearance subset, reachable from anywhere.
 *
 * ## Scope note
 *
 * Only the platform preferences are here. Notification categories (§5.9),
 * consent scopes (§10.10), and export (§9.10) are all real settings surfaces
 * and all belong to later milestones — a toggle that writes nothing would be
 * worse than its absence.
 */
/**
 * The pages this drawer points at.
 *
 * Everything above the divider applies to *this device* and takes effect
 * immediately. These do not: they are stored on the profile, or they describe
 * what the system does rather than what it should do, and both deserve a page
 * with room to explain themselves rather than a toggle in a sheet.
 *
 * The list previously ended with a disabled "not built yet" toggle for
 * notification categories. That was honest when nothing existed; now
 * `/settings/notifications` says the same thing at greater length and with the
 * stored preferences visible, so the dead control is gone rather than sitting
 * next to a live link to the page that replaced it.
 */
const ELSEWHERE: readonly { readonly href: string; readonly label: string }[] = Object.freeze([
  { href: '/settings/ai', label: 'AI — what may be sent, what it may cost, and a switch that turns it off' },
  { href: '/settings/appearance', label: 'Appearance — and which of theme, density and motion actually take effect' },
  { href: '/settings/capture', label: 'Capture — the quick-capture rail and its shortcuts' },
  { href: '/settings/notifications', label: 'Notifications — opt-in only, and currently silent' },
  { href: '/settings/integrations', label: 'Integrations — what can be imported, and what cannot' },
  { href: '/settings/profile', label: 'Profile — identity, zone, clinical context' },
]);

export function SettingsDrawer(): ReactNode {
  const isOpen = useNavigationStore((state) => state.isSettingsOpen);
  const setOpen = useNavigationStore((state) => state.setSettingsOpen);

  const theme = useAppearanceStore((state) => state.theme);
  const setTheme = useAppearanceStore((state) => state.setTheme);
  const density = useAppearanceStore((state) => state.density);
  const setDensity = useAppearanceStore((state) => state.setDensity);
  const motion = useAppearanceStore((state) => state.motion);
  const setMotion = useAppearanceStore((state) => state.setMotion);

  return (
    <Sheet
      open={isOpen}
      onOpenChange={setOpen}
      title="Appearance"
      description="Applies immediately, on this device."
      // Right on desktop, bottom on mobile — the component decides by side, and
      // the shell asks for `right` because settings are a companion to content
      // rather than a capture flow.
      side="right"
    >
      <Stack gap="6">
        <Stack gap="2">
          <Text role="title-3" as="h3">
            Theme
          </Text>
          <SegmentedControl
            label="Theme"
            fullWidth
            options={THEMES.map((value) => ({
              value,
              label: value === 'system' ? 'System' : value === 'dark' ? 'Dark' : 'Light',
              icon: value === 'dark' ? 'theme.dark' : value === 'light' ? 'theme.light' : 'theme.system',
            }))}
            value={theme}
            onValueChange={setTheme}
          />
          <Text role="caption" tone="tertiary">
            Dark is the default. The application is opened last thing at night and in dim rooms.
          </Text>
        </Stack>

        <Divider />

        <Stack gap="2">
          <Text role="title-3" as="h3">
            Density
          </Text>
          <SegmentedControl
            label="Density"
            fullWidth
            options={DENSITIES.map((value) => ({
              value,
              label: value === 'comfortable' ? 'Comfortable' : 'Compact',
              icon: value === 'comfortable' ? 'data.rows' : 'data.grid',
            }))}
            value={density}
            onValueChange={setDensity}
          />
          <Text role="caption" tone="tertiary">
            Compact tightens spacing for reviewing long histories. Comfortable keeps controls at
            full size for one-handed use.
          </Text>
        </Stack>

        <Divider />

        <Stack gap="2">
          <Text role="title-3" as="h3">
            Motion
          </Text>
          <SegmentedControl
            label="Motion"
            fullWidth
            options={MOTION_PREFERENCES.map((value) => ({
              value,
              label: value === 'system' ? 'System' : value === 'full' ? 'Full' : 'Reduced',
            }))}
            value={motion}
            onValueChange={setMotion}
          />
          <Text role="caption" tone="tertiary">
            Reduced removes transitions and holds animations still. `System` follows your
            device setting.
          </Text>
        </Stack>

        <Divider />

        {/*
          Everything in this drawer applies to *this device* and takes effect
          immediately. Consent is neither of those things — it is stored on the
          profile and it decides what leaves the machine — so it gets a page
          rather than a toggle here, and the drawer links to it.
        */}
        <Stack gap="2">
          <Text role="title-3" as="h3">
            Elsewhere
          </Text>
          {ELSEWHERE.map((entry) => (
            <Link
              key={entry.href}
              className="nos-inline-link"
              href={entry.href}
              onClick={() => {
                setOpen(false);
              }}
            >
              {entry.label}
            </Link>
          ))}
        </Stack>

      </Stack>
    </Sheet>
  );
}
