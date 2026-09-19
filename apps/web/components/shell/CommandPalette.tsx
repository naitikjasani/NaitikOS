'use client';

import { Command } from 'cmdk';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Icon, Text } from '@naitikos/design-system';

import { QUICK_CAPTURE_CHORDS } from '@/lib/capture/rail';
import { useAppearanceStore } from '@/lib/stores/appearance.store';
import { useNavigationStore } from '@/lib/stores/navigation.store';
import { DESTINATION_GROUPS, destinationFor, type Destination } from './navigation-tree';

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
 * ## Why it indexes all of §3.2 rather than a curated shortlist
 *
 * It previously listed the eight surfaces plus two hand-written groups. At
 * ninety routes, a curated shortlist is a promise the palette cannot keep: the
 * one time it matters is when the operator is looking for the route they use
 * twice a year — `/body/health/labs`, `/settings/data/export` — and a shortlist
 * is by construction the set of routes they did not need help finding. The
 * index is now `navigation-tree`, whole, and the curation happens in the
 * ranking rather than in the contents.
 *
 * ## Why cmdk
 *
 * It supplies the filtering, the roving focus model, and the aria wiring for a
 * combobox-with-listbox — which is one of the harder ARIA patterns to get right
 * and one where a mistake makes the whole thing unusable with a screen reader.
 * The registry and the styling are ours.
 */

/**
 * The searchable text for a destination.
 *
 * The href is included on purpose: it makes `gym/log` and `settings/data` work
 * as queries, which is how anyone who has seen the URL bar will search. The
 * ancestor trail is included because half the leaf labels in §3.2 collide —
 * "Photos" alone matches three routes, and only "skin photos" separates them.
 */
function searchValue(destination: Destination): string {
  return [...destination.trail, destination.label, destination.href].join(' ');
}

export function CommandPalette(): ReactNode {
  const router = useRouter();
  const isOpen = useNavigationStore((state) => state.isCommandPaletteOpen);
  const setOpen = useNavigationStore((state) => state.setCommandPaletteOpen);
  const setSettingsOpen = useNavigationStore((state) => state.setSettingsOpen);
  const openCapture = useNavigationStore((state) => state.openCapture);
  const beginNavigation = useNavigationStore((state) => state.beginNavigation);
  const recentHrefs = useNavigationStore((state) => state.recentHrefs);
  const theme = useAppearanceStore((state) => state.theme);
  const setTheme = useAppearanceStore((state) => state.setTheme);

  /**
   * The query is controlled for one reason: the recents group is shown only
   * while it is empty. Ranking recents against a typed query would put a route
   * you happened to open this morning above the one you actually asked for,
   * which is the failure mode that makes people stop trusting a palette.
   */
  const [query, setQuery] = useState('');

  const run = (action: () => void): void => {
    // Close first, then act. Acting first can unmount the palette mid-handler
    // and leave focus nowhere, which strands a keyboard user.
    setOpen(false);
    setQuery('');
    action();
  };

  const go = (href: string): void => {
    run(() => {
      // The shell's pending state is set here as well as in `NavLink`, because
      // a `router.push` fires no click and would otherwise navigate with no
      // feedback at all — the palette closes and nothing appears to happen.
      beginNavigation(href);
      router.push(href);
    });
  };

  const recents = recentHrefs
    .map((href) => destinationFor(href))
    .filter((destination): destination is Destination => destination !== undefined)
    .slice(0, 5);

  return (
    <Command.Dialog
      open={isOpen}
      onOpenChange={(open) => {
        setOpen(open);
        if (!open) setQuery('');
      }}
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
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder="Search or jump to…"
          className="palette__input"
        />
      </div>

      <Command.List className="palette__list">
        <Command.Empty className="palette__empty">
          <Text role="title-3" as="p">
            No destination matches “{query}”
          </Text>
          {/*
            An empty state that says what would appear here (§8.8). The second
            line is the honest boundary of this surface: it indexes routes and
            actions, not rows, and telling someone that is kinder than letting
            them conclude their data is missing.
          */}
          <Text role="body-sm" tone="secondary">
            This searches every screen in the system. Searching your data —
            foods, exercises, journal entries — arrives with the first domain.
          </Text>
        </Command.Empty>

        {query === '' && recents.length > 0 && (
          <Command.Group heading="Recent" className="palette__group">
            {recents.map((destination) => (
              <DestinationItem
                key={`recent-${destination.href}`}
                destination={destination}
                prefix="recent"
                onSelect={go}
              />
            ))}
          </Command.Group>
        )}

        {/*
          §3.3(4): quick capture is "keyboard-shortcut driven on desktop (`c`
          then a domain key)". A chord nobody can discover is a chord nobody
          uses, so the palette lists them — it is the only surface in the app
          that a person opens *looking* for what is possible.

          Placed above the destinations because §1's whole premise is that
          capture is the product; a palette that ranks browsing above recording
          has the priorities backwards.
        */}
        <Command.Group heading="Capture" className="palette__group">
          {QUICK_CAPTURE_CHORDS.map((chord) => (
            <Command.Item
              key={chord.chord}
              value={`capture log ${chord.label}`}
              onSelect={() => {
                setQuery('');
                openCapture(chord.metricKey);
              }}
              className="palette__item"
            >
              <Icon name="action.add" label={null} size="sm" />
              <span className="palette__label">{chord.label}</span>
              <kbd className="palette__hint">{chord.chord}</kbd>
            </Command.Item>
          ))}
        </Command.Group>

        {/*
          Every destination in §3.2, grouped by surface. Ask has no entry in the
          primary navigation and is reachable only from here — §2.5 makes it
          "deliberately not the primary interface", and a tab for it would be
          the shell arguing the opposite. The palette is where a person goes
          *looking* for a capability, which is the right posture to arrive in.
        */}
        {DESTINATION_GROUPS.map((group) => (
          <Command.Group key={group.label} heading={group.label} className="palette__group">
            {group.items.map((destination) => (
              <DestinationItem key={destination.href} destination={destination} onSelect={go} />
            ))}
          </Command.Group>
        ))}

        <Command.Group heading="Appearance" className="palette__group">
          {/*
            Theme switching from the palette.
            A keyboard path to the one setting most likely to be changed at
            an awkward moment — §8.7's "opened last thing at night" case.
          */}
          <Command.Item
            value="theme dark appearance"
            onSelect={() => {
              run(() => {
                setTheme('dark');
              });
            }}
            className="palette__item"
          >
            <Icon name="theme.dark" label={null} size="sm" />
            <span className="palette__label">Dark theme</span>
            {theme === 'dark' && <Icon name="action.confirm" label="Selected" size="sm" />}
          </Command.Item>
          <Command.Item
            value="theme light appearance"
            onSelect={() => {
              run(() => {
                setTheme('light');
              });
            }}
            className="palette__item"
          >
            <Icon name="theme.light" label={null} size="sm" />
            <span className="palette__label">Light theme</span>
            {theme === 'light' && <Icon name="action.confirm" label="Selected" size="sm" />}
          </Command.Item>
          <Command.Item
            value="theme system appearance"
            onSelect={() => {
              run(() => {
                setTheme('system');
              });
            }}
            className="palette__item"
          >
            <Icon name="theme.system" label={null} size="sm" />
            <span className="palette__label">Follow system</span>
            {theme === 'system' && <Icon name="action.confirm" label="Selected" size="sm" />}
          </Command.Item>
          <Command.Item
            value="open settings drawer"
            onSelect={() => {
              run(() => {
                setSettingsOpen(true);
              });
            }}
            className="palette__item"
          >
            <Icon name="nav.settings" label={null} size="sm" />
            <span className="palette__label">Quick settings</span>
          </Command.Item>
        </Command.Group>
      </Command.List>

      {/*
        The keyboard legend is not decoration. This surface is keyboard-only by
        design on desktop, and §8.13's "full keyboard operability" is worth
        little if the operator has to guess that ↵ opens and ⎋ closes.
      */}
      <div className="palette__footer">
        <Text role="caption" tone="tertiary" as="span">
          <kbd className="palette__key">↑</kbd>
          <kbd className="palette__key">↓</kbd> move · <kbd className="palette__key">↵</kbd> open ·{' '}
          <kbd className="palette__key">esc</kbd> close
        </Text>
      </div>
    </Command.Dialog>
  );
}

/**
 * One destination row.
 *
 * The trail is rendered as well as searched. Without it "Photos" under the
 * heading "Body" is still three different pages, and choosing between them by
 * guessing is exactly what the palette is meant to remove.
 */
function DestinationItem({
  destination,
  prefix,
  onSelect,
}: {
  readonly destination: Destination;
  /** Disambiguates the same href appearing under Recent and under its surface. */
  readonly prefix?: string;
  readonly onSelect: (href: string) => void;
}): ReactNode {
  const context = destination.trail.slice(1).join(' › ');

  return (
    <Command.Item
      value={`${prefix ?? ''} ${searchValue(destination)}`}
      onSelect={() => {
        onSelect(destination.href);
      }}
      className="palette__item"
    >
      <Icon name={destination.icon} label={null} size="sm" />
      <span className="palette__label">{destination.label}</span>
      {context !== '' && <span className="palette__context">{context}</span>}
    </Command.Item>
  );
}
