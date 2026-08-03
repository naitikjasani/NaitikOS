'use client';

/**
 * The sign-in form.
 *
 * Validated with the same Zod schema the route handler uses — §5.1: "The same
 * Zod schema validates the form, the route handler, and the domain object. One
 * definition, three enforcement points."
 *
 * Client validation here is purely an ergonomic shortcut. The server validates
 * independently and does not trust anything below.
 */

import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { signInRequestSchema } from '@naitikos/api';
import { STRATEGY_REGISTRY } from '@naitikos/core';

import { signIn } from '../services/authClient';

export type SignInFormProps = {
  /** Validated destination from `?next=`, or the default. */
  readonly redirectTo: string;
};

type FieldErrors = { email?: string; password?: string };

export function SignInForm({ redirectTo }: SignInFormProps): ReactNode {
  const router = useRouter();
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});

    const parsed = signInRequestSchema.safeParse({ email, password, redirectTo });

    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'email' && next.email === undefined) next.email = issue.message;
        if (field === 'password' && next.password === undefined) next.password = issue.message;
        // A `redirectTo` failure is not the user's doing — they did not type
        // it. Reported as a form error rather than against a field they
        // cannot see.
        if (field === 'redirectTo') setFormError('That sign-in link is not valid.');
      }
      setFieldErrors(next);
      return;
    }

    setIsSubmitting(true);

    try {
      const result = await signIn(parsed.data);

      if (!result.ok) {
        setFormError(
          result.error.retryAfterSeconds === undefined
            ? result.error.message
            : `Too many attempts. Try again in ${String(Math.ceil(result.error.retryAfterSeconds / 60))} minute(s).`,
        );
        setPassword('');
        return;
      }

      /**
       * `refresh()` before navigating.
       *
       * The Router Cache holds the signed-out render of the destination. Going
       * straight to `replace()` shows that stale output until the next
       * revalidation, which looks like a failed sign-in.
       */
      router.refresh();
      router.replace(result.redirectTo);
    } catch {
      // A thrown fetch means the network failed, not that credentials were
      // wrong. Saying "invalid credentials" here would send the user hunting
      // for a password problem that does not exist.
      setFormError('Could not reach the server. Check your connection and try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate>
      {formError !== null && (
        // `role="alert"` announces it to a screen reader without moving focus.
        <p className="alert" role="alert" id={errorId}>
          {formError}
        </p>
      )}

      <div className="field">
        <label htmlFor={emailId}>Email</label>
        <input
          id={emailId}
          name="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          // The operator opens this several times a day on a phone.
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          disabled={isSubmitting}
          aria-invalid={fieldErrors.email !== undefined}
          aria-describedby={fieldErrors.email === undefined ? undefined : `${emailId}-error`}
        />
        {fieldErrors.email !== undefined && (
          <span className="field-error" id={`${emailId}-error`}>
            {fieldErrors.email}
          </span>
        )}
      </div>

      <div className="field">
        <label htmlFor={passwordId}>Password</label>
        <input
          id={passwordId}
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          disabled={isSubmitting}
          aria-invalid={fieldErrors.password !== undefined}
          aria-describedby={fieldErrors.password === undefined ? undefined : `${passwordId}-error`}
        />
        {fieldErrors.password !== undefined && (
          <span className="field-error" id={`${passwordId}-error`}>
            {fieldErrors.password}
          </span>
        )}
      </div>

      <button className="button" type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Signing in…' : 'Sign in'}
      </button>

      {/*
        The §5.4 divergence, stated in the UI rather than only in a comment.
        The blueprint prefers passkey and magic link; keeping the gap visible is
        what stops "temporarily using passwords" becoming permanent by default.
      */}
      {!STRATEGY_REGISTRY.passkey.enabled && (
        <p className="muted" style={{ marginTop: 'calc(var(--space) * 2)' }}>
          Passkey and email link sign-in are the intended factors and are not enabled yet.
        </p>
      )}
    </form>
  );
}
