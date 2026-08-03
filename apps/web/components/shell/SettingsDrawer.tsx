'use client';

import type { ReactNode } from 'react';
import {
  Divider,
  SegmentedControl,
  Sheet,
  Stack,
  Text,
  ToggleField,
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
          Named rather than silently absent.
          §2.1 and §5.9 both define settings that do not exist yet; listing them
          as unbuilt is more honest than an empty screen that implies these are
          the only preferences the system will ever have.
        */}
        <Stack gap="2">
          <Text role="title-3" as="h3">
            Not built yet
          </Text>
          <Stack gap="1">
            <ToggleField
              label="Notification categories"
              description="Opt-in per category, off by default. Arrives with the Daily Close."
              checked={false}
              onCheckedChange={() => undefined}
              disabled
            />
            <ToggleField
              label="AI consent scopes"
              description="Nothing crosses an inference boundary. The AI layer is off."
              checked={false}
              onCheckedChange={() => undefined}
              disabled
            />
          </Stack>
        </Stack>
      </Stack>
    </Sheet>
  );
}
