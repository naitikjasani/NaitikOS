/**
 * Conflict detection between goals — §4.10's least obvious feature and its most
 * useful one.
 *
 *   "explicit conflict detection between goals — a bulk and a visible-abs goal
 *    are in tension, and the system should say so rather than let both quietly
 *    fail."
 *
 * The failure being prevented is specific and common: two goals are declared
 * six weeks apart, neither is wrong, and together they are unachievable. Nobody
 * notices, both stall, and the conclusion drawn is "I have no discipline"
 * rather than "these two things cannot both happen".
 *
 * ## It reports, it does not arbitrate
 *
 * A tension is stated as a fact about two declarations. This module never picks
 * a winner, never scores which goal matters more, and never suggests dropping
 * one. Which of your goals matters more is not a thing a computer knows, and P5
 * draws the line in exactly this place.
 *
 * ## Two kinds, and the second is the one worth having
 *
 * **Direct** — two active targets on the *same metric* pulling opposite ways.
 * Easy, mechanical, and rare in practice, because a person rarely writes two
 * contradictory targets on one number.
 *
 * **Antagonistic** — two targets on *different* metrics that a small, explicit
 * table says are physiologically opposed. A calorie surplus and a body-fat
 * reduction is the canonical case, and no amount of reasoning over metric keys
 * would discover it. So the pairs are declared, hand-written, few, and each
 * carries the sentence explaining itself.
 *
 * That table is deliberately small. Every entry is a claim about the body, and
 * P5 means each one has to be defensible on its own — a generated list of
 * "metrics that correlate negatively" would be exactly the unfounded assertion
 * §10.6 exists to prevent.
 */

import type { Goal, GoalTarget } from './target';
import { describeTarget } from './target';

export type TensionKind = 'direct' | 'antagonistic';

export type GoalTension = {
  /** Deterministic and order-independent, so re-deriving does not duplicate. */
  readonly id: string;
  readonly kind: TensionKind;
  readonly goalIds: readonly [string, string];
  readonly targetIds: readonly [string, string];
  /** What the two declarations are, in one sentence each. */
  readonly claim: string;
  /** Why they pull against each other. Never a recommendation. */
  readonly reason: string;
};

/**
 * Pairs of metrics that pull against each other, with the reason.
 *
 * Hand-written, and short by design. Each entry is a physiological claim; the
 * bar for adding one is that the sentence beside it would survive being read
 * out to a clinician.
 */
export const ANTAGONISTIC_PAIRS: readonly {
  readonly a: string;
  readonly b: string;
  /** The direction on `a` that conflicts with `bDirection` on `b`. */
  readonly aDirection: 'up' | 'down';
  readonly bDirection: 'up' | 'down';
  readonly reason: string;
}[] = Object.freeze([
  {
    a: 'nutrition.energy',
    aDirection: 'up',
    b: 'body.fat_percentage',
    bDirection: 'down',
    reason:
      'A calorie surplus and a reduction in body fat are opposed over the same weeks. §4.10 names this pair: a bulk and a visible-abs goal are in tension.',
  },
  {
    a: 'body.weight',
    aDirection: 'up',
    b: 'body.fat_percentage',
    bDirection: 'down',
    reason:
      'Gaining weight while losing body fat is possible early in training and rarely for long. Both targets can be met for a while and then stop being met together.',
  },
  {
    a: 'nutrition.energy',
    aDirection: 'down',
    b: 'gym.session.volume',
    bDirection: 'up',
    reason:
      'A calorie deficit and a rising training volume compete for the same recovery. Neither is wrong; sustaining both at once usually is not.',
  },
]);

type ActiveTarget = { readonly goal: Goal; readonly target: GoalTarget };

/**
 * Every tension between the supplied goals.
 *
 * Only `active` goals are considered. A paused or abandoned goal is not in
 * tension with anything — it is not being pursued — and reporting one would
 * turn goal archaeology into a nagging surface, which §14.1's no-guilt rule
 * forbids.
 */
export function detectTensions(
  goals: readonly Goal[],
  targets: readonly GoalTarget[],
): readonly GoalTension[] {
  const byId = new Map(goals.filter((goal) => goal.status === 'active').map((goal) => [goal.id, goal]));

  const active: ActiveTarget[] = [];
  for (const target of targets) {
    const goal = byId.get(target.goalId);
    if (goal !== undefined) active.push({ goal, target });
  }

  const tensions: GoalTension[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const left = active[i];
      const right = active[j];
      if (left === undefined || right === undefined) continue;
      /* A goal is not in tension with itself; two targets on one goal are the
       * operator saying one thing two ways. */
      if (left.goal.id === right.goal.id) continue;

      const found = compare(left, right);
      if (found === null) continue;
      if (seen.has(found.id)) continue;
      seen.add(found.id);
      tensions.push(found);
    }
  }

  return tensions;
}

function compare(left: ActiveTarget, right: ActiveTarget): GoalTension | null {
  const claim = `“${left.goal.title}” wants ${describeTarget(left.target)}; “${right.goal.title}” wants ${describeTarget(right.target)}.`;

  if (left.target.metricKey === right.target.metricKey) {
    const opposed =
      (directionOf(left.target) === 'up' && directionOf(right.target) === 'down') ||
      (directionOf(left.target) === 'down' && directionOf(right.target) === 'up');
    if (!opposed) return null;
    return {
      id: tensionId('direct', left.target.id, right.target.id),
      kind: 'direct',
      goalIds: orderedPair(left.goal.id, right.goal.id),
      targetIds: orderedPair(left.target.id, right.target.id),
      claim,
      reason: `Both targets are on ${left.target.metricKey}, and they point in opposite directions.`,
    };
  }

  for (const pair of ANTAGONISTIC_PAIRS) {
    const forward =
      left.target.metricKey === pair.a &&
      right.target.metricKey === pair.b &&
      directionOf(left.target) === pair.aDirection &&
      directionOf(right.target) === pair.bDirection;
    const reverse =
      left.target.metricKey === pair.b &&
      right.target.metricKey === pair.a &&
      directionOf(left.target) === pair.bDirection &&
      directionOf(right.target) === pair.aDirection;

    if (forward || reverse) {
      return {
        id: tensionId('antagonistic', left.target.id, right.target.id),
        kind: 'antagonistic',
        goalIds: orderedPair(left.goal.id, right.goal.id),
        targetIds: orderedPair(left.target.id, right.target.id),
        claim,
        reason: pair.reason,
      };
    }
  }

  return null;
}

/**
 * Which way a target pushes its metric.
 *
 * A rate target's direction is the *sign of the rate*, not the comparator —
 * "at least −0.25 kg/week" is a cut, and reading its `at_least` as "up" would
 * report a cut and a bulk as compatible.
 */
function directionOf(target: GoalTarget): 'up' | 'down' {
  if (target.comparator === 'rate_of_change') return Number(target.targetValue) >= 0 ? 'up' : 'down';
  return target.comparator === 'at_least' ? 'up' : 'down';
}

/** Sorted, so the same pair produces one id whichever way round it is found. */
function orderedPair(a: string, b: string): readonly [string, string] {
  return a <= b ? [a, b] : [b, a];
}

function tensionId(kind: TensionKind, a: string, b: string): string {
  const [first, second] = orderedPair(a, b);
  return `${kind}:${first}:${second}`;
}
