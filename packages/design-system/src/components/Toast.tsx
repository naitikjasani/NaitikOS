'use client';

import * as ToastPrimitive from '@radix-ui/react-toast';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { Icon } from '../icons/Icon';
import { Text } from '../primitives/Text';

/**
 * Toasts — transient confirmation (§8.12).
 *
 * ## Why this component matters more than it looks
 *
 * §8.12 makes the undo toast the *primary* protection for destructive actions,
 * above confirmation dialogs:
 *
 *   "Deletion is soft (§9.4) and produces an undo toast. Confirmation dialogs
 *    train people to click through them; undo actually protects data."
 *
 * So `action` is not a decoration — it is the data-safety mechanism. A toast
 * carrying an undo must stay long enough to be noticed and acted on, which is
 * why `duration` defaults higher when an action is present.
 *
 * ## What a toast must never be
 *
 * P6: "No badges. No red numbers. No push notification that exists to drive
 * engagement rather than to serve a decision." A toast confirms something the
 * user just did. It never congratulates, never nudges, and never reports a
 * health value.
 */

export type ToastTone = 'neutral' | 'positive' | 'caution' | 'critical';

export type ToastOptions = {
  readonly title: string;
  readonly description?: string;
  readonly tone?: ToastTone;
  /** The undo affordance. See the note above — this is a safety feature. */
  readonly action?: { readonly label: string; readonly onAction: () => void };
  /** Milliseconds. Defaults to 5s, or 10s when an action is present. */
  readonly duration?: number;
};

type ToastRecord = ToastOptions & { readonly id: string };

type ToastContextValue = {
  /** Show a toast. Returns its id so a caller can dismiss it early. */
  readonly toast: (options: ToastOptions) => string;
  readonly dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (value === null) {
    throw new Error('useToast must be used inside <ToastProvider>.');
  }
  return value;
}

const TONE_ICON = {
  neutral: 'status.info',
  positive: 'status.success',
  caution: 'status.warning',
  critical: 'status.error',
} as const;

export function ToastProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<readonly ToastRecord[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const toast = useCallback((options: ToastOptions): string => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { ...options, id }]);
    return id;
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider swipeDirection="right">
        {children}

        {toasts.map((entry) => (
          <ToastPrimitive.Root
            key={entry.id}
            className={cn('nos-toast', `nos-toast--${entry.tone ?? 'neutral'}`)}
            // An undoable action gets double the time. Five seconds is enough
            // to read a confirmation and not enough to notice, decide, and
            // reach for a button.
            duration={entry.duration ?? (entry.action === undefined ? 5000 : 10000)}
            onOpenChange={(open) => {
              if (!open) dismiss(entry.id);
            }}
          >
            <Icon name={TONE_ICON[entry.tone ?? 'neutral']} label={null} size="md" />

            <div className="nos-toast__text">
              <ToastPrimitive.Title asChild>
                <Text role="body-sm">{entry.title}</Text>
              </ToastPrimitive.Title>
              {entry.description !== undefined && (
                <ToastPrimitive.Description asChild>
                  <Text role="caption" tone="secondary">
                    {entry.description}
                  </Text>
                </ToastPrimitive.Description>
              )}
            </div>

            {entry.action !== undefined && (
              <ToastPrimitive.Action asChild altText={entry.action.label}>
                <button type="button" className="nos-toast__action" onClick={entry.action.onAction}>
                  {entry.action.label}
                </button>
              </ToastPrimitive.Action>
            )}

            <ToastPrimitive.Close className="nos-toast__close" aria-label="Dismiss">
              <Icon name="nav.close" label={null} size="sm" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}

        {/* Bottom placement (§8.12) and, on mobile, above the tab bar — a
            toast that covers the navigation is a toast that blocks the way
            out. The offset is handled in CSS via the shell's safe-area vars. */}
        <ToastPrimitive.Viewport className="nos-toast-viewport" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}
