/**
 * Guided journal prompts — §3.2's `/mind/journal/prompts`, as reference data.
 *
 * Reference data rather than fixtures, for the same reason the exercise library
 * is: an empty prompt list makes the feature invisible, and §4.7 lists guided
 * prompts as part of the journal rather than as an extra.
 *
 * ## The rules these were written against
 *
 * **Nothing presumes a bad day.** "What was hardest today?" is a leading
 * question that asks the operator to find something hard, and on a good day the
 * honest answer is nothing — at which point the prompt has taught them the
 * feature is not for them. Every prompt below is answerable on any day.
 *
 * **Nothing is therapeutic instruction.** §4.7 keeps the system out of the
 * business of intervening: no reframing exercises, no gratitude mandates, no
 * "list three things you did well". A prompt is a question, and the operator's
 * answer is the record.
 *
 * **Nothing asks for a rating.** Ratings are the Daily Close's job and they are
 * one tap there. A journal prompt that asks for a number is a Close field in the
 * wrong place, competing with the eleven-element budget from outside it (§4.0).
 *
 * The rotation is deterministic in the day key (`core/domain/mind/journal.ts`),
 * so today's prompt is the same question on the phone and the laptop.
 */

export type SeedPrompt = {
  readonly prompt: string;
  readonly category: string;
};

export const SEED_PROMPTS: readonly SeedPrompt[] = [
  { prompt: 'What happened today that you want to remember?', category: 'record' },
  { prompt: 'What took up the most room in your head today?', category: 'attention' },
  { prompt: 'What did today ask of you?', category: 'load' },
  { prompt: 'What is unresolved right now?', category: 'open' },
  { prompt: 'What changed since last week?', category: 'change' },
  { prompt: 'Who did you speak to, and what stayed with you?', category: 'people' },
  { prompt: 'What did your body do today, and how did it feel?', category: 'body' },
  { prompt: 'What did you decide today?', category: 'decisions' },
  { prompt: 'What are you looking forward to, or dreading?', category: 'ahead' },
  { prompt: 'What is one thing you noticed that you would not have noticed a year ago?', category: 'change' },
  { prompt: 'What would you tell someone who asked how you are, honestly?', category: 'state' },
  { prompt: 'What is taking longer than you expected?', category: 'open' },
  { prompt: 'What did you avoid today?', category: 'attention' },
  { prompt: 'What do you want tomorrow to look like?', category: 'ahead' },
];
