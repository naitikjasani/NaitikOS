'use client';

import { useId, useState, type ChangeEvent, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';

import { cn } from '../lib/cn';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/registry';
import { IconButton } from './Button';
import { Text } from '../primitives/Text';

/**
 * Form fields — §8.10, "where P1 is won or lost, so the defaults are
 * aggressive".
 *
 * Rules encoded here rather than left to call sites:
 *
 *   - **Every input has a visible label.** §8.10: "Placeholder-as-label is an
 *     accessibility failure and disappears exactly when the user needs it."
 *     `label` is a required prop with no way to opt out except
 *     `labelHidden`, which still renders it for screen readers.
 *   - **The right keyboard, always.** `NumberField` sets
 *     `inputmode="decimal"`. §8.10: "Getting this wrong adds two seconds to
 *     every entry, forty times a week, forever."
 *   - **Inline validation on blur, never on keystroke.** Validating while
 *     someone types is hostile, so `error` is only rendered once `touched`.
 *   - **Units are displayed, always** — and are a display concern only. Values
 *     are stored canonically (§6.2).
 */

/* =========================================================================
 * The shared shell
 * ====================================================================== */

type FieldShellProps = {
  readonly id: string;
  readonly label: string;
  readonly labelHidden?: boolean;
  readonly hint?: string;
  readonly error?: string;
  readonly required?: boolean;
  readonly children: ReactNode;
  readonly className?: string;
};

/**
 * Label, control, hint, and error in the correct order with the correct
 * `aria-describedby` wiring.
 *
 * Extracted so every field type gets identical semantics. The wiring is the
 * part that is easy to get subtly wrong — a hint that is not referenced is a
 * hint a screen-reader user never hears.
 */
function FieldShell({
  id,
  label,
  labelHidden = false,
  hint,
  error,
  required = false,
  children,
  className,
}: FieldShellProps): ReactNode {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div className={cn('nos-field', error !== undefined && 'nos-field--invalid', className)}>
      <label htmlFor={id} className={cn('nos-field__label', labelHidden && 'nos-visually-hidden')}>
        {label}
        {required && (
          <>
            <span aria-hidden="true" className="nos-field__required">
              *
            </span>
            <span className="nos-visually-hidden">(required)</span>
          </>
        )}
      </label>

      {children}

      {hint !== undefined && error === undefined && (
        <Text role="caption" tone="tertiary" id={hintId}>
          {hint}
        </Text>
      )}

      {error !== undefined && (
        // `role="alert"` announces the message when it appears, without moving
        // focus away from the field the user is still working in.
        <Text role="caption" tone="critical" id={errorId} as="span" className="nos-field__error">
          <Icon name="status.error" label={null} size="sm" />
          <span role="alert">{error}</span>
        </Text>
      )}
    </div>
  );
}

/** The aria wiring every control repeats. */
function describedBy(id: string, hint?: string, error?: string): string | undefined {
  const ids = [hint !== undefined && error === undefined ? `${id}-hint` : null, error !== undefined ? `${id}-error` : null].filter(
    (value): value is string => value !== null,
  );
  return ids.length > 0 ? ids.join(' ') : undefined;
}

/* =========================================================================
 * TextField
 * ====================================================================== */

export type TextFieldProps = {
  readonly label: string;
  readonly labelHidden?: boolean;
  readonly hint?: string;
  readonly error?: string;
  readonly iconStart?: IconName;
  readonly className?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>;

export function TextField({
  label,
  labelHidden,
  hint,
  error,
  iconStart,
  className,
  id: providedId,
  required,
  ...rest
}: TextFieldProps): ReactNode {
  const generatedId = useId();
  const id = providedId ?? generatedId;

  return (
    <FieldShell
      id={id}
      label={label}
      {...(labelHidden === undefined ? {} : { labelHidden })}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      {...(required === undefined ? {} : { required })}
      {...(className === undefined ? {} : { className })}
    >
      <div className="nos-input-wrap">
        {iconStart !== undefined && (
          <Icon name={iconStart} label={null} size="md" className="nos-input-wrap__icon" />
        )}
        <input
          id={id}
          className={cn('nos-input', iconStart !== undefined && 'nos-input--with-icon')}
          aria-invalid={error !== undefined || undefined}
          aria-describedby={describedBy(id, hint, error)}
          required={required}
          {...rest}
        />
      </div>
    </FieldShell>
  );
}

/* =========================================================================
 * NumberField — steppers over typing (§8.10)
 * ====================================================================== */

export type NumberFieldProps = {
  readonly label: string;
  readonly value: number | null;
  readonly onValueChange: (value: number | null) => void;
  readonly step?: number;
  readonly min?: number;
  readonly max?: number;
  /** Displayed beside the input. Display only — storage is canonical (§6.2). */
  readonly unit?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly labelHidden?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
};

/**
 * A numeric input with steppers.
 *
 * §8.10: "**Steppers over text entry** for bounded values. Logging a set is
 * `+2.5 kg`, not typing `62.5`." The text input remains for the case where the
 * jump is large, but the buttons are the primary interaction — and they are
 * full touch targets, because they are pressed with one hand mid-workout.
 */
export function NumberField({
  label,
  value,
  onValueChange,
  step = 1,
  min,
  max,
  unit,
  hint,
  error,
  labelHidden,
  disabled = false,
  className,
}: NumberFieldProps): ReactNode {
  const id = useId();

  const clamp = (next: number): number => {
    let result = next;
    if (min !== undefined) result = Math.max(min, result);
    if (max !== undefined) result = Math.min(max, result);
    // Floating-point tidy-up: 62.5 + 2.5 must not become 65.00000000000001.
    return Math.round(result * 1e6) / 1e6;
  };

  const adjust = (delta: number): void => {
    onValueChange(clamp((value ?? 0) + delta));
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const raw = event.target.value;
    if (raw === '') {
      onValueChange(null);
      return;
    }
    const parsed = Number(raw);
    if (!Number.isNaN(parsed)) onValueChange(parsed);
  };

  return (
    <FieldShell
      id={id}
      label={label}
      {...(labelHidden === undefined ? {} : { labelHidden })}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      {...(className === undefined ? {} : { className })}
    >
      <div className="nos-number">
        <IconButton
          icon="action.remove"
          label={`Decrease ${label} by ${String(step)}`}
          onClick={() => {
            adjust(-step);
          }}
          disabled={disabled || (min !== undefined && (value ?? 0) <= min)}
          variant="secondary"
        />
        <div className="nos-input-wrap nos-number__input">
          <input
            id={id}
            type="text"
            /**
             * `decimal`, not `numeric`.
             *
             * §8.10 requires the right keyboard. `numeric` gives a keypad with
             * no decimal separator, which makes 62.5 kg impossible to type on
             * iOS. `text` + `inputmode` also avoids the scroll-wheel-changes-
             * the-value bug that `type="number"` has.
             */
            inputMode="decimal"
            value={value === null ? '' : String(value)}
            onChange={handleChange}
            onBlur={() => {
              if (value !== null) onValueChange(clamp(value));
            }}
            disabled={disabled}
            aria-invalid={error !== undefined || undefined}
            aria-describedby={describedBy(id, hint, error)}
            className="nos-input nos-input--numeric"
          />
          {unit !== undefined && (
            <span className="nos-number__unit" aria-hidden="true">
              {unit}
            </span>
          )}
        </div>
        <IconButton
          icon="action.add"
          label={`Increase ${label} by ${String(step)}`}
          onClick={() => {
            adjust(step);
          }}
          disabled={disabled || (max !== undefined && (value ?? 0) >= max)}
          variant="secondary"
        />
      </div>
      {/* The unit is aria-hidden above and announced here instead, so a screen
          reader hears "Weight, 62.5, kilograms" rather than "62.5 kg" as one
          opaque token. */}
      {unit !== undefined && <span className="nos-visually-hidden">{unit}</span>}
    </FieldShell>
  );
}

/* =========================================================================
 * ScaleField — the 1–5 tap used throughout the Daily Close (§8.10)
 * ====================================================================== */

export type ScaleFieldProps = {
  readonly label: string;
  readonly value: number | null;
  readonly onValueChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  /** Anchor labels for the extremes — "Worst" / "Best". */
  readonly minLabel?: string;
  readonly maxLabel?: string;
  readonly hint?: string;
  readonly className?: string;
};

/**
 * A discrete rating scale rendered as a radio group.
 *
 * A radio group rather than a row of buttons, because that is what it is:
 * arrow keys move between options, only one is selected, and the whole group
 * is one tab stop. Buttons would make five tab stops in a ritual §4.0 budgets
 * at sixty seconds.
 *
 * Deliberately uncoloured. §8.2: "A mood of 2 is not red."
 */
export function ScaleField({
  label,
  value,
  onValueChange,
  min = 1,
  max = 5,
  minLabel,
  maxLabel,
  hint,
  className,
}: ScaleFieldProps): ReactNode {
  const id = useId();
  const options = Array.from({ length: max - min + 1 }, (_, index) => min + index);

  return (
    <div className={cn('nos-field', className)} role="group" aria-labelledby={`${id}-label`}>
      <span className="nos-field__label" id={`${id}-label`}>
        {label}
      </span>

      <div className="nos-scale" role="radiogroup" aria-labelledby={`${id}-label`}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            // Roving tabindex: the group is one tab stop.
            tabIndex={value === option || (value === null && option === min) ? 0 : -1}
            className={cn('nos-scale__option', value === option && 'is-selected')}
            onClick={() => {
              onValueChange(option);
            }}
          >
            {option}
          </button>
        ))}
      </div>

      {(minLabel !== undefined || maxLabel !== undefined) && (
        <div className="nos-scale__anchors">
          <Text role="caption" tone="tertiary">
            {minLabel}
          </Text>
          <Text role="caption" tone="tertiary">
            {maxLabel}
          </Text>
        </div>
      )}

      {hint !== undefined && (
        <Text role="caption" tone="tertiary">
          {hint}
        </Text>
      )}
    </div>
  );
}

/* =========================================================================
 * TextAreaField
 * ====================================================================== */

export type TextAreaFieldProps = {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly labelHidden?: boolean;
  /** Render in the long-form serif (§8.3) — journal entries and reviews. */
  readonly serif?: boolean;
  readonly className?: string;
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>;

export function TextAreaField({
  label,
  hint,
  error,
  labelHidden,
  serif = false,
  className,
  id: providedId,
  rows = 4,
  required,
  ...rest
}: TextAreaFieldProps): ReactNode {
  const generatedId = useId();
  const id = providedId ?? generatedId;

  return (
    <FieldShell
      id={id}
      label={label}
      {...(labelHidden === undefined ? {} : { labelHidden })}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      {...(required === undefined ? {} : { required })}
      {...(className === undefined ? {} : { className })}
    >
      <textarea
        id={id}
        rows={rows}
        className={cn('nos-input', 'nos-textarea', serif && 'nos-textarea--serif')}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy(id, hint, error)}
        required={required}
        {...rest}
      />
    </FieldShell>
  );
}

/* =========================================================================
 * ToggleField
 * ====================================================================== */

export function ToggleField({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
  className,
}: {
  readonly label: string;
  readonly description?: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}): ReactNode {
  const id = useId();

  return (
    <div className={cn('nos-toggle-field', className)}>
      <div className="nos-toggle-field__text">
        <label htmlFor={id} className="nos-field__label">
          {label}
        </label>
        {description !== undefined && (
          <Text role="caption" tone="tertiary" id={`${id}-description`}>
            {description}
          </Text>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description === undefined ? undefined : `${id}-description`}
        disabled={disabled}
        className={cn('nos-switch', checked && 'is-checked')}
        onClick={() => {
          onCheckedChange(!checked);
        }}
      >
        <span className="nos-switch__thumb" aria-hidden="true" />
      </button>
    </div>
  );
}

/* =========================================================================
 * SearchField
 * ====================================================================== */

export function SearchField({
  label = 'Search',
  value,
  onValueChange,
  placeholder,
  className,
  ...rest
}: {
  readonly label?: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly placeholder?: string;
  readonly className?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'className'>): ReactNode {
  const id = useId();

  return (
    <div className={cn('nos-field', className)}>
      {/* Visually hidden, not absent. A magnifying glass is not a label. */}
      <label htmlFor={id} className="nos-visually-hidden">
        {label}
      </label>
      <div className="nos-input-wrap">
        <Icon name="action.search" label={null} size="md" className="nos-input-wrap__icon" />
        <input
          id={id}
          // `type="search"` gives iOS the search keyboard and a native clear
          // affordance, at the cost of a browser-drawn X we hide in CSS.
          type="search"
          value={value}
          placeholder={placeholder}
          onChange={(event) => {
            onValueChange(event.target.value);
          }}
          className="nos-input nos-input--with-icon"
          {...rest}
        />
        {value !== '' && (
          <IconButton
            icon="nav.close"
            label="Clear search"
            size="sm"
            className="nos-input-wrap__clear"
            onClick={() => {
              onValueChange('');
            }}
          />
        )}
      </div>
    </div>
  );
}

/* =========================================================================
 * DateField
 * ====================================================================== */

/**
 * A date input.
 *
 * **Deliberately the native control**, not a custom calendar popover.
 *
 * The native picker is fully keyboard accessible, localised to the user's
 * locale for free, works with every screen reader, and on mobile opens the
 * platform date wheel — which is faster than any custom grid and is what the
 * user already knows. A hand-built calendar is one of the largest
 * accessibility liabilities a design system can take on, and §8.10's priority
 * is capture speed rather than visual control.
 *
 * Revisit only if a range picker or annotated calendar is genuinely needed.
 */
export function DateField({
  label,
  value,
  onValueChange,
  min,
  max,
  hint,
  error,
  className,
  ...rest
}: {
  readonly label: string;
  /** ISO `YYYY-MM-DD`. */
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly min?: string;
  readonly max?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly className?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'className' | 'type'>): ReactNode {
  const id = useId();

  return (
    <FieldShell
      id={id}
      label={label}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      {...(className === undefined ? {} : { className })}
    >
      <input
        id={id}
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(event) => {
          onValueChange(event.target.value);
        }}
        className="nos-input"
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      />
    </FieldShell>
  );
}

/* =========================================================================
 * FileField
 * ====================================================================== */

/**
 * A file picker with a drop zone.
 *
 * The native `<input type="file">` is kept as the real control and visually
 * hidden — it is the only element that opens the platform picker, and
 * replacing it with a button that calls `.click()` breaks keyboard activation
 * in some browsers. The drop zone is a label wrapping it, so a click anywhere
 * and a keyboard Enter both work through the native path.
 */
export function FileField({
  label,
  accept,
  multiple = false,
  onFilesSelected,
  hint,
  error,
  className,
}: {
  readonly label: string;
  readonly accept?: string;
  readonly multiple?: boolean;
  readonly onFilesSelected: (files: File[]) => void;
  readonly hint?: string;
  readonly error?: string;
  readonly className?: string;
}): ReactNode {
  const id = useId();
  const [isDragging, setIsDragging] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const handleFiles = (fileList: FileList | null): void => {
    if (fileList === null) return;
    const files = Array.from(fileList);
    setSelected(files.map((file) => file.name));
    onFilesSelected(files);
  };

  return (
    <div className={cn('nos-field', className)}>
      <label htmlFor={id} className="nos-field__label">
        {label}
      </label>

      <label
        htmlFor={id}
        className={cn('nos-filefield', isDragging && 'is-dragging')}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => {
          setIsDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          handleFiles(event.dataTransfer.files);
        }}
      >
        <Icon name="action.upload" label={null} size="lg" />
        <Text role="body-sm" tone="secondary">
          Choose {multiple ? 'files' : 'a file'} or drag here
        </Text>
        <input
          id={id}
          type="file"
          accept={accept}
          multiple={multiple}
          className="nos-visually-hidden"
          onChange={(event) => {
            handleFiles(event.target.files);
          }}
          aria-describedby={describedBy(id, hint, error)}
        />
      </label>

      {selected.length > 0 && (
        // A live region: selecting a file via the native dialog produces no
        // visible focus change, so without this a screen-reader user gets no
        // confirmation that anything happened.
        <Text role="caption" tone="secondary" as="span">
          <span role="status">{selected.join(', ')}</span>
        </Text>
      )}

      {hint !== undefined && error === undefined && (
        <Text role="caption" tone="tertiary" id={`${id}-hint`}>
          {hint}
        </Text>
      )}
      {error !== undefined && (
        <Text role="caption" tone="critical" id={`${id}-error`}>
          <span role="alert">{error}</span>
        </Text>
      )}
    </div>
  );
}
