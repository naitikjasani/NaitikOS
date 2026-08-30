'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { uuidV7 } from '@naitikos/shared';
import {
  DEFAULT_SLOTS,
  MAX_TEMPLATE_SUGGESTIONS,
  TARGET_STATUS_LABELS,
  foodLabel,
  formatMeasured,
  systemClock,
  toQuantityString,
  nutrientForMetricKey,
} from '@naitikos/core';
import type { MealTier, TargetEvaluation } from '@naitikos/core';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  Grid,
  Inline,
  Stack,
  Text,
  useToast,
} from '@naitikos/design-system';

import { recordMealLogDuration } from '@/lib/telemetry/client';
import type { LogSurface, SuggestionView } from '@/lib/platform/nutrition';
import { deleteMeal, logMeal, type MealItemDraft } from '../services/nutritionClient';
import { QuantitySheet } from '../components/QuantitySheet';

/**
 * `/body/nutrition/log` — the ten-second surface.
 *
 * §2.2 makes this the module's ship gate: "if logging a meal takes longer than
 * ten seconds, the module has failed." Every decision below is downstream of
 * that sentence, so they are written down rather than left to be rediscovered.
 *
 * ## The picker *is* the screen
 *
 * There is no dashboard above the fold and no "add meal" button that reveals a
 * picker. Opening this route puts a thumb one tap away from a logged meal.
 * A summary card at the top would cost a scroll on every meal for information
 * that is on `/body/nutrition` and is not needed to answer "what did I eat".
 *
 * The remaining-against-target strip is the one exception, and it is one line
 * per metric with no chart, because it is the thing that changes what you would
 * pick — it is *input* to the decision, not a report on it.
 *
 * ## Undo, not confirm
 *
 * §4.3 asks for confirmation on tier 3 only. A dialog seen three times a day is
 * a dialog nobody reads, and §8.12 is explicit that "confirmation dialogs train
 * people to click through them; undo actually protects data". So a template tap
 * writes immediately and produces an undo toast.
 *
 * ## The tile's default quantity is the last quantity used
 *
 * A person eating 100 g of oats every morning types "100" exactly once, ever.
 * The quantity editor is a long press — reachable, never on the critical path.
 * A food never eaten has no default and falls into the same editor, which is
 * honest: the system has nothing to guess with (P5).
 *
 * ## The clock
 *
 * Starts when this component mounts, ends when the write is durable in
 * IndexedDB. Not at `timeOrigin`, because §2.2's claim is about the picker and
 * not about how fast Next.js boots; not at the server response, because §5.7
 * makes the operator finished before the network is.
 */

export type MealLogScreenProps = {
  readonly surface: LogSurface;
  readonly zone: string;
};

type Selection = {
  readonly foodId: string;
  readonly versionId: string;
  readonly name: string;
  readonly quantity: string;
  readonly unit: string;
};

export function MealLogScreen({ surface, zone }: MealLogScreenProps): ReactNode {
  const router = useRouter();
  const { toast } = useToast();

  /*
   * The clock.
   *
   * A ref rather than state: it must not be reset by a re-render, and it is
   * never rendered, so it has no business causing one. Started in an effect
   * rather than in the ref's initialiser because `performance.now()` is impure
   * and a render may run twice — which would also be the *wrong* moment. The
   * effect fires after paint, which is when the picker is actually on screen
   * and the operator can start tapping.
   */
  const openedAt = useRef<number>(0);

  useEffect(() => {
    openedAt.current = performance.now();
  }, []);

  const [slot, setSlot] = useState<string>(surface.slot);
  const [selected, setSelected] = useState<readonly Selection[]>([]);
  const [editing, setEditing] = useState<SuggestionView | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedIds = useMemo(() => new Set(selected.map((entry) => entry.foodId)), [selected]);

  /**
   * Write, tell the operator it is done, and offer to take it back.
   *
   * The router refresh happens after the toast rather than before it, so the
   * confirmation is on screen while the server round trip resolves. On a slow
   * connection that difference is the whole ten seconds.
   */
  const commit = useCallback(
    async (input: {
      readonly items: readonly MealItemDraft[];
      readonly templateId: string | null;
      readonly tier: MealTier;
      readonly label: string;
    }): Promise<void> => {
      if (input.items.length === 0 || busy) return;
      setBusy(true);

      const mealId = uuidV7(systemClock.nowMillis());
      try {
        await logMeal({
          id: mealId,
          eatenAt: surface.nowIso,
          zone,
          slot,
          note: null,
          templateId: input.templateId,
          captureTier: input.tier,
          items: input.items,
        });

        recordMealLogDuration(openedAt.current, '/body/nutrition/log');
        openedAt.current = performance.now();

        setSelected([]);
        toast({
          title: `${input.label} logged`,
          tone: 'positive',
          action: {
            label: 'Undo',
            onAction: () => {
              void deleteMeal(mealId).then(() => {
                router.refresh();
              });
            },
          },
        });
        router.refresh();
      } catch {
        /*
         * §5.7 means this almost never fires — the queue accepts the write
         * offline. When it does, the meal is *not* recorded, and saying so is
         * the only honest option.
         */
        toast({ title: 'Could not save that meal', tone: 'critical' });
      } finally {
        setBusy(false);
      }
    },
    [busy, router, slot, surface.nowIso, toast, zone],
  );

  if (surface.libraryIsEmpty) {
    return (
      <EmptyState
        icon="nav.body"
        title="No foods yet"
        description="This screen ranks the things you actually eat, so it needs a library first. The seeded list covers the usual Indian vegetarian staples — if it is missing, the seed has not run."
        action={{
          label: 'Open the food library',
          onAction: () => {
            router.push('/body/nutrition/foods');
          },
        }}
      />
    );
  }

  return (
    <Stack gap="4">
      {/* --- What is left today ---------------------------------------- */}
      {surface.evaluations.length > 0 && <RemainingStrip evaluations={surface.evaluations} />}

      {/* --- Which meal this is ---------------------------------------- */}
      <Inline gap="2" wrap>
        {slotsFor(surface).map((option) => (
          <Button
            key={option}
            size="sm"
            variant={option === slot ? 'primary' : 'ghost'}
            onClick={() => {
              setSlot(option);
            }}
          >
            {option}
          </Button>
        ))}
      </Inline>

      {/* --- One tap ---------------------------------------------------- */}
      {surface.templates.length > 0 && (
        <Stack gap="2">
          <Text role="caption" tone="tertiary">
            Saved meals
          </Text>
          <Grid gap="2" minColumnWidth="10rem">
            {surface.templates.slice(0, MAX_TEMPLATE_SUGGESTIONS).map((entry) => (
              <Button
                key={entry.template.id}
                variant="secondary"
                size="lg"
                fullWidth
                disabled={!entry.resolvable || busy}
                onClick={() => {
                  void commitTemplate(entry.template.id);
                }}
              >
                {entry.template.name}
              </Button>
            ))}
          </Grid>
          {surface.templates.some((entry) => !entry.resolvable) && (
            /* Stated, not hidden. A template whose food lost its version would
             * otherwise be a button that silently does nothing. */
            <Text role="caption" tone="tertiary">
              A greyed-out meal has a food with no current version. Open it under Saved meals to fix it.
            </Text>
          )}
        </Stack>
      )}

      {/* --- Four taps -------------------------------------------------- */}
      <Stack gap="2">
        <Inline justify="between" align="center">
          <Text role="caption" tone="tertiary">
            Most likely right now
          </Text>
          <Link className="nos-inline-link" href="/body/nutrition/foods">
            All foods
          </Link>
        </Inline>

        <Grid gap="2" minColumnWidth="7.5rem">
          {surface.suggestions.map((entry) => (
            <FoodTile
              key={entry.foodId}
              entry={entry}
              isSelected={selectedIds.has(entry.foodId)}
              onToggle={() => {
                toggle(entry);
              }}
              onEdit={() => {
                setEditing(entry);
              }}
            />
          ))}
        </Grid>
      </Stack>

      {/* --- The commit ------------------------------------------------- */}
      {selected.length > 0 && (
        <Card variant="outlined">
          <CardBody>
            <Stack gap="3">
              <Stack gap="1">
                {selected.map((entry) => (
                  <Inline key={entry.foodId} justify="between" align="center">
                    <Text role="body-sm" as="span">
                      {entry.name}
                    </Text>
                    <Text role="caption" tone="secondary">
                      {formatMeasured(entry.quantity)} {entry.unit}
                    </Text>
                  </Inline>
                ))}
              </Stack>
              <Button
                variant="primary"
                size="lg"
                fullWidth
                isLoading={busy}
                onClick={() => {
                  void commit({
                    items: selected.map((entry) => ({
                      id: uuidV7(systemClock.nowMillis()),
                      foodVersionId: entry.versionId,
                      quantity: entry.quantity,
                      unit: entry.unit,
                      parsedFromText: null,
                    })),
                    templateId: null,
                    tier: 'suggestion',
                    label: slot,
                  });
                }}
              >
                Log {String(selected.length)} {selected.length === 1 ? 'item' : 'items'}
              </Button>
            </Stack>
          </CardBody>
        </Card>
      )}

      {/* --- Today, below the fold on purpose --------------------------- */}
      {surface.meals.length > 0 && (
        <Stack gap="2">
          <Text role="caption" tone="tertiary">
            Logged today
          </Text>
          {surface.meals.map((meal) => (
            <Card key={meal.id} variant="flat">
              <CardBody>
                <Inline justify="between" align="center" wrap>
                  <Text role="body-sm" as="span">
                    {meal.items.map((item) => item.foodName).join(', ')}
                  </Text>
                  <Text role="caption" tone="tertiary">
                    {meal.slot ?? '—'}
                  </Text>
                </Inline>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}

      {editing !== null && (
        <QuantitySheet
          entry={editing}
          onClose={() => {
            setEditing(null);
          }}
          onConfirm={(quantity, unit) => {
            const target = editing;
            setEditing(null);
            const versionId = target.versionId;
            if (versionId === null) return;
            setSelected((current) => [
              ...current.filter((item) => item.foodId !== target.foodId),
              {
                foodId: target.foodId,
                versionId,
                name: foodLabel(target.food),
                quantity,
                unit,
              },
            ]);
          }}
        />
      )}
    </Stack>
  );

  function toggle(entry: SuggestionView): void {
    if (selectedIds.has(entry.foodId)) {
      setSelected((current) => current.filter((item) => item.foodId !== entry.foodId));
      return;
    }

    /*
     * No default quantity means the system has never seen this food eaten, so
     * it opens the editor rather than inventing a serving. Guessing "1" here
     * would put a number nobody chose into an append-only log.
     */
    const { defaultQuantity, defaultUnit, versionId } = entry;
    if (defaultQuantity === null || defaultUnit === null || versionId === null) {
      setEditing(entry);
      return;
    }

    setSelected((current) => [
      ...current,
      { foodId: entry.foodId, versionId, name: foodLabel(entry.food), quantity: defaultQuantity, unit: defaultUnit },
    ]);
  }

  async function commitTemplate(templateId: string): Promise<void> {
    const entry = surface.templates.find((candidate) => candidate.template.id === templateId);
    if (entry === undefined) return;

    /*
     * The template's items are resolved to versions on the server, which is why
     * this posts the ids it already has rather than re-resolving here — the
     * client's copy of "current version" is as old as the page.
     */
    const items = entry.template.items.flatMap((item): MealItemDraft[] => {
      const suggestion = surface.suggestions.find((candidate) => candidate.foodId === item.foodId);
      if (suggestion?.versionId == null) return [];
      return [
        {
          id: uuidV7(systemClock.nowMillis()),
          foodVersionId: suggestion.versionId,
          quantity: item.quantity,
          unit: item.unit,
          parsedFromText: null,
        },
      ];
    });

    await commit({ items, templateId, tier: 'template', label: entry.template.name });
  }
}

/* -------------------------------------------------------------------------
 * The strip
 * ---------------------------------------------------------------------- */

/**
 * What is left against each target, as a sentence per metric.
 *
 * No progress bars and no colour-coded rings. §4.7 and §14.1 both rule out the
 * guilt framing, and a red bar at 60% of a protein target at two in the
 * afternoon is exactly that. "84 g left" is the same information with none of
 * the judgement, and it is also the number that changes what you would pick.
 */
function RemainingStrip({ evaluations }: { readonly evaluations: readonly TargetEvaluation[] }): ReactNode {
  return (
    <Card variant="flat">
      <CardBody>
        <Grid gap="3" minColumnWidth="9rem">
          {evaluations.map((evaluation) => {
            const nutrient = nutrientForMetricKey(evaluation.metricKey);
            return (
              <Stack key={evaluation.metricKey} gap="1">
                <Text role="caption" tone="tertiary">
                  {nutrient?.displayName ?? evaluation.metricKey}
                </Text>
                <Text role="title-3" as="span">
                  {evaluation.remaining === null
                    ? 'met'
                    : `${formatMeasured(toQuantityString(evaluation.remaining))} ${evaluation.unit}`}
                </Text>
                <Text role="caption" tone="tertiary">
                  {evaluation.status === 'unknown' ? 'nothing logged' : `${TARGET_STATUS_LABELS[evaluation.status]} · left`}
                </Text>
              </Stack>
            );
          })}
        </Grid>
      </CardBody>
    </Card>
  );
}

/* -------------------------------------------------------------------------
 * The tile
 * ---------------------------------------------------------------------- */

/** How long a press has to be held before it means "edit" rather than "add". */
const LONG_PRESS_MS = 450;

function FoodTile({
  entry,
  isSelected,
  onToggle,
  onEdit,
}: {
  readonly entry: SuggestionView;
  readonly isSelected: boolean;
  readonly onToggle: () => void;
  readonly onEdit: () => void;
}): ReactNode {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);

  const start = (): void => {
    fired.current = false;
    timer.current = setTimeout(() => {
      fired.current = true;
      onEdit();
    }, LONG_PRESS_MS);
  };

  const end = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (!fired.current) onToggle();
  };

  const cancel = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    fired.current = true;
  };

  const quantity =
    entry.defaultQuantity === null || entry.defaultUnit === null
      ? 'set amount'
      : `${formatMeasured(entry.defaultQuantity)} ${entry.defaultUnit}`;

  return (
    <button
      type="button"
      className={`nos-food-tile${isSelected ? ' nos-food-tile--selected' : ''}`}
      aria-pressed={isSelected}
      onPointerDown={start}
      onPointerUp={end}
      onPointerLeave={cancel}
      /*
       * The keyboard path is a plain activation and a separate control, because
       * a long press has no keyboard equivalent. §8.13: nothing may be reachable
       * only by a gesture.
       */
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (event.shiftKey) onEdit();
          else onToggle();
        }
      }}
    >
      <span className="nos-food-tile__name">{foodLabel(entry.food)}</span>
      <span className="nos-food-tile__quantity">{quantity}</span>
      {isSelected && (
        <span className="nos-food-tile__mark" aria-hidden="true">
          ✓
        </span>
      )}
    </button>
  );
}

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */


/**
 * The slots offered, which are the operator's own plus the defaults.
 *
 * §4.3 keeps `slot` free text — "a person who eats five times a day has five
 * slots, not four" — so a slot that has been used before stays offered even
 * though it is not in {@link DEFAULT_SLOTS}.
 */
function slotsFor(surface: LogSurface): readonly string[] {
  const used = surface.meals.flatMap((meal) => (meal.slot === null ? [] : [meal.slot]));
  return [...new Set([...DEFAULT_SLOTS, ...used, surface.slot])];
}
