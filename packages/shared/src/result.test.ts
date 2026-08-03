import { describe, expect, it } from 'vitest';

import { all, andThen, err, fromPromise, isErr, isOk, map, mapErr, match, ok, unwrapOr } from './result';

describe('Result', () => {
  it('constructs and narrows both branches', () => {
    const success = ok(42);
    const failure = err('boom');

    expect(isOk(success)).toBe(true);
    expect(isErr(failure)).toBe(true);
    if (isOk(success)) expect(success.value).toBe(42);
    if (isErr(failure)) expect(failure.error).toBe('boom');
  });

  it('maps success and passes failure through untouched', () => {
    expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
    expect(map(err<string>('boom'), (n: number) => n * 3)).toEqual(err('boom'));
  });

  it('maps the error and passes success through untouched', () => {
    expect(mapErr(err('boom'), (e) => `${e}!`)).toEqual(err('boom!'));
    expect(mapErr(ok(1), (e: string) => `${e}!`)).toEqual(ok(1));
  });

  it('chains fallible computations, short-circuiting on the first failure', () => {
    const double = (n: number) => ok(n * 2);
    const fail = () => err('nope');

    expect(andThen(ok(2), double)).toEqual(ok(4));
    expect(andThen(andThen(ok(2), fail), double)).toEqual(err('nope'));
  });

  it('collapses both branches with match', () => {
    const render = (r: ReturnType<typeof ok<number>> | ReturnType<typeof err<string>>) =>
      match(r, { onOk: (v) => `ok:${String(v)}`, onErr: (e) => `err:${e}` });

    expect(render(ok(1))).toBe('ok:1');
    expect(render(err('x'))).toBe('err:x');
  });

  it('substitutes a fallback on failure', () => {
    expect(unwrapOr(ok(1), 99)).toBe(1);
    expect(unwrapOr(err('x'), 99)).toBe(99);
  });

  it('collects an array, failing on the first error', () => {
    expect(all([ok(1), ok(2), ok(3)])).toEqual(ok([1, 2, 3]));
    expect(all([ok(1), err('bad'), ok(3)])).toEqual(err('bad'));
  });

  it('captures a rejected promise as a failure rather than throwing', async () => {
    const rejected = fromPromise(Promise.reject(new Error('network')), (caught) =>
      caught instanceof Error ? caught.message : 'unknown',
    );

    await expect(rejected).resolves.toEqual(err('network'));
  });
});
