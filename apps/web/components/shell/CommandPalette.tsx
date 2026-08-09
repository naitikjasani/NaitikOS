'use client';

import { Command } from 'cmdk';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Icon, Text } from '@naitikos/design-system';

import { QUICK_CAPTURE_CHORDS } from '@/features/capture';
import { PRIMARY_NAV, showsUnbuiltRoutes } from '@/lib/navigation/config';
import { useAppearanceStore } from '@/lib/stores/appearance.store';
import { useNavigationStore } from '@/lib/stores/navigation.store';

/**
 * The command palette — ⌘K.
 *
 * ## What this is architecturally
 *
 * The **search architecture**, singular. §2.5 forbids "an in-app 'everything'
 * search that queries live LLM context", and §2.2 puts the Ask surface in V2.
 * That leaves a keyboard-driven registry of navigation targets and actions,
 * which is what this is — and it is deliberately *not* a data search. When data
 * search arrives it will be Postgres full-text plus trigram (§9.6), surfaced
 * through this same palette as an additional group.
 *
 * ## Why cmdk
 *
 * It supplies the filtering, the roving focus model, and the aria wiring for a
 * combobox-with-listbox — which is one of the harder ARIA patterns to get right
 * and one where a mistake makes the whole thing unusable with a screen reader.
 * The registry and the styling are ours.
 *
 * The commands live here rather than in a feature because the palette is
 * platform infrastructure. Features will register into it; none exist yet.
 */
export function CommandPalette(): ReactNode {
  const router = useRouter();
  const isOpen = useNavigationStore((state) => state.isCommandPaletteOpen);
  const setOpen = useNavigationStore((state) => state.setCommandPaletteOpen);
  const setSettingsOpen = useNavigationStore((state) => state.setSettingsOpen);
  const openCapture = useNavigationStore((state) => state.openCapture);
  const theme = useAppearanceStore((state) => state.theme);
  const setTheme = useAppearanceStore((state) => state.setTheme);

  const navTargets = PRIMARY_NAV.filter((item) => item.available || showsUnbuiltRoutes());

  const run = (action: () => void): void => {
    // Close first, then act. Acting first can unmount the palette mid-handler
    // and leave focus nowhere, which strands a keyboard user.
    setOpen(false);
    action();
  };

  return (
    <Command.Dialog
      open={isOpen}
      onOpenChange={setOpen}
      label="Search and commands"
      className="palette"
      // cmdk renders a Radix Dialog underneath, so focus trapping, escape, and
      // scroll locking come from the same primitives as every other overlay
      // (§8.12).
      overlayClassName="nos-overlay"
      contentClassName="palette__content"
    >
      <div className="palette__input-row">
        <Icon name="action.search" label={null} size="md" />
        <Command.Input placeholder="Search or jump to…" className="palette__input" />
      </div>

      <Command.List className="palette__list">
        <Command.Empty className="palette__empty">
          <Text role="body-sm" tone="secondary">
            Nothing matches. Data search arrives with the first domain.
          </Text>
        </Command.Empty>

        <Command.Group heading="Go to" className="palette__group">
          {navTargets.map((item) => (
            <Command.Item
              key={item.id}
              value={`go ${item.label}`}
              disabled={!item.available}
              onSelect={() => {
                run(() => {
                  router.push(item.href);
                });
              }}
              className="palette__item"
            >
              <Icon name={item.icon} label={null} size="sm" />
              <span>{item.label}</span>
              {!item.available && (
                <span className="palette__hint" aria-hidden="true">
                  not built
                </span>
              )}
            </Command.Item>
          ))}
        </Command.Group>

        {/*
          §3.3(4): quick capture is "keyboard-shortcut driven on desktop (`c`
          then a domain key)". A chord nobody can discover is a chord nobody
          uses, so the palette lists them — it is the only surface in the app
          that a person opens *looking* for what is possible.

          Selecting one opens the same sheet the chord does, because both go
          through the shell store rather than through component state.
        */}
        <Command.Group heading="Quick capture" className="palette__group">
          {QUICK_CAPTURE_CHORDS.map((chord) => (
            <Command.Item
              key={chord.chord}
              value={`capture ${chord.label}`}
              onSelect={() => {
                openCapture(chord.metricKey);
              }}
              className="palette__item"
            >
              <Icon name="action.add" label={null} size="sm" />
              <span>{chord.label}</span>
              <kbd className="palette__hint">{chord.chord}</kbd>
            </Command.Item>
          ))}
        </Command.Group>

        <Command.Group heading="Appearance" className="palette__group">
          {/*
            Theme switching from the palette.
            A keyboard path to the one setting most likely to be changed at
            an awkward moment — §8.7's "opened last thing at night" case.
          */}
          <Command.Item
            value="theme dark"
            onSelect={() => {
              run(() => {
                setTheme('dark');
              });
            }}
            className="palette__item"
          >
            <Icon name="theme.dark" label={null} size="sm" />
            <span>Dark theme</span>
            {theme === 'dark' && <Icon name="action.confirm" label={null} size="sm" />}
          </Command.Item>
          <Command.Item
            value="theme light"
            onSelect={() => {
              run(() => {
                setTheme('light');
              });
            }}
            className="palette__item"
          >
            <Icon name="theme.light" label={null} size="sm" />
            <span>Light theme</span>
            {theme === 'light' && <Icon name="action.confirm" label={null} size="sm" />}
          </Command.Item>
          <Command.Item
            value="theme system"
            onSelect={() => {
              run(() => {
                setTheme('system');
              });
            }}
            className="palette__item"
          >
            <Icon name="theme.system" label={null} size="sm" />
            <span>Follow system</span>
            {theme === 'system' && <Icon name="action.confirm" label={null} size="sm" />}
          </Command.Item>
        </Command.Group>

        <Command.Group heading="Settings" className="palette__group">
          <Command.Item
            value="open settings"
            onSelect={() => {
              run(() => {
                setSettingsOpen(true);
              });
            }}
            className="palette__item"
          >
            <Icon name="nav.settings" label={null} size="sm" />
            <span>Open settings</span>
          </Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
