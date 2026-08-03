/**
 * Authentication strategies — which credentials the system will accept.
 *
 * ## A recorded divergence from §5.4
 *
 * The blueprint specifies "email magic link plus **passkey (WebAuthn) as the
 * preferred factor**". The identity milestone was scoped to email/password
 * instead, with OAuth architecturally supported and disabled.
 *
 * That is a product decision and this file does not argue with it. What it does
 * is make the divergence *cheap to undo*: a strategy is a value in a registry,
 * not a branch in a flow. Adding magic link or passkey later means one entry
 * here, one adapter method, and one form — no change to the guards, the
 * session model, the allowlist, or the audit trail, because none of those ever
 * asks how the user signed in.
 *
 * The security properties §5.4 actually cared about are preserved regardless of
 * mechanism: the single-email allowlist, sign-up disabled at the provider,
 * server-side checking on every request, and step-up for sensitive operations.
 * Those live in `allowlist.ts` and `actor.ts` and are strategy-independent by
 * construction.
 *
 * ## Why passwords are the weaker choice, recorded for whoever revisits this
 *
 * §5.4 preferred passkeys for phishing resistance and for the mobile experience
 * "which matters for a system opened several times a day". A password on a
 * database of psychiatric history and body photographs is also the one
 * credential a user can be socially engineered into disclosing. The
 * `preferred` flag below is not decorative — it is where that judgement is
 * recorded so a future maintainer knows the current default is a waypoint.
 */

/** Every credential type the system can express. */
export const AUTH_STRATEGIES = ['password', 'magic_link', 'passkey', 'oauth_google'] as const;

export type AuthStrategy = (typeof AUTH_STRATEGIES)[number];

export type StrategyDescriptor = {
  readonly id: AuthStrategy;
  readonly label: string;
  /** Whether the strategy can currently be used. */
  readonly enabled: boolean;
  /**
   * Whether §5.4 would choose this one.
   *
   * Surfaced in the UI to order the options, and in `docs/auth.md` to keep the
   * gap between the blueprint and the implementation visible rather than
   * forgotten.
   */
  readonly preferred: boolean;
  /** Whether enabling this requires provider configuration beyond a flag. */
  readonly requiresProviderSetup: boolean;
  /** Why it is in its current state — read by a maintainer, not by the app. */
  readonly note: string;
};

export const STRATEGY_REGISTRY: Readonly<Record<AuthStrategy, StrategyDescriptor>> = Object.freeze({
  password: {
    id: 'password',
    label: 'Email and password',
    enabled: true,
    preferred: false,
    requiresProviderSetup: false,
    note: 'Current default. Diverges from §5.4, which prefers passkey and magic link.',
  },
  magic_link: {
    id: 'magic_link',
    label: 'Email a sign-in link',
    enabled: false,
    preferred: true,
    requiresProviderSetup: true,
    note: 'Specified by §5.4. Needs SMTP configured on the Supabase project. The adapter method exists.',
  },
  passkey: {
    id: 'passkey',
    label: 'Passkey',
    enabled: false,
    preferred: true,
    requiresProviderSetup: true,
    note: '§5.4 calls this the preferred factor — phishing resistant, better on mobile. Needs a WebAuthn ceremony the adapter does not yet implement.',
  },
  oauth_google: {
    id: 'oauth_google',
    label: 'Continue with Google',
    enabled: false,
    preferred: false,
    requiresProviderSetup: true,
    note: 'Architecturally supported, deliberately off. See the note below on why this is not a free addition.',
  },
});

/**
 * Strategies a sign-in surface should offer, preferred ones first.
 *
 * The UI renders this list. It never hardcodes a button, so enabling magic link
 * is a one-line change in the registry above and the form follows.
 */
export function enabledStrategies(): readonly StrategyDescriptor[] {
  return AUTH_STRATEGIES.map((id) => STRATEGY_REGISTRY[id])
    .filter((s) => s.enabled)
    .sort((a, b) => Number(b.preferred) - Number(a.preferred));
}

export function isStrategyEnabled(id: AuthStrategy): boolean {
  return STRATEGY_REGISTRY[id].enabled;
}

export function isAuthStrategy(value: unknown): value is AuthStrategy {
  return typeof value === 'string' && (AUTH_STRATEGIES as readonly string[]).includes(value);
}

/**
 * OAuth strategies, and the caution that goes with them.
 *
 * Google sign-in is supported here because the milestone asked for it, and the
 * plumbing is genuinely complete — the callback route, the code exchange, and
 * the allowlist check all handle it. It stays disabled, and the reason is worth
 * writing down rather than rediscovering.
 *
 * P7 says the architecture must "make leakage *impossible*, not *prohibited*".
 * An OAuth provider does not receive health data, but it does learn every
 * sign-in time — which for a daily-use health tool is a behavioural record of
 * when its user was awake, anxious, or in a clinic. That is a smaller leak than
 * an analytics SDK and it is not zero, and it accrues to a third party the user
 * cannot audit.
 *
 * Enabling it is a legitimate call. Making it *silently* is not, which is why
 * the flag lives in version control next to this paragraph rather than in a
 * provider dashboard.
 */
export const OAUTH_STRATEGIES: readonly AuthStrategy[] = Object.freeze(['oauth_google']);

export function isOAuthStrategy(id: AuthStrategy): boolean {
  return OAUTH_STRATEGIES.includes(id);
}
