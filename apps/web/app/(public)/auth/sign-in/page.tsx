/**
 * /auth/sign-in
 *
 * §6.2: "A page file imports a feature's exported screen component and renders
 * it. Twelve lines, typically."
 */

import type { ReactNode } from 'react';
import { redirectPathSchema } from '@naitikos/api';

import { SignInScreen } from '@/features/auth';
import { DEFAULT_AUTHENTICATED_PATH } from '@/lib/auth/routes';

export const metadata = { title: 'Sign in · Ekayu' };

/** §5.6: never cached. A sign-in page is per-request by definition. */
export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const params = await searchParams;
  const next = params['next'];

  /**
   * `?next=` arrives in a URL someone may have been sent, so it is untrusted
   * input. Re-validated with the same schema the API uses; anything that fails
   * falls back to the default rather than erroring, because a malformed
   * redirect should not block sign-in.
   */
  const candidate = typeof next === 'string' ? next : undefined;
  const parsed = candidate === undefined ? null : redirectPathSchema.safeParse(candidate);
  const redirectTo = parsed?.success === true ? parsed.data : DEFAULT_AUTHENTICATED_PATH;

  return <SignInScreen redirectTo={redirectTo} />;
}
