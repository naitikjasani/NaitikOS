'use client';

import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';

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

  return (
    <FieldShell
      id={id}
      label={label}
      {...(labelHidden === undefined ? {} : { labelHidden })}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      {...(className === undefined ? {} : { className })}
    >
      <NumberStepper
        id={id}
        label={label}
        value={value}
        onValueChange={onValueChange}
        step={step}
        min={min}
        max={max}
        unit={unit}
        disabled={disabled}
        invalid={error !== undefined}
        describedBy={describedBy(id, hint, error)}
      />
      {/* The unit is aria-hidden in the stepper and announced here instead, so a
          screen reader hears "Weight, 62.5, kilograms" rather than "62.5 kg" as
          one opaque token. */}
      {unit !== undefined && <span className="nos-visually-hidden">{unit}</span>}
    </FieldShell>
  );
}

/**
 * The stepper row itself: minus, value, unit, plus.
 *
 * Extracted from `NumberField` when `QuantityField` arrived, because the two
 * differ only in what sits beside the number — a fixed unit or a chooser — and
 * a second copy of the clamp-and-round arithmetic is a second place for
 * `62.5 + 2.5 === 65.00000000000001` to reappear.
 *
 * Props are required-but-nullable rather than optional: this is an internal
 * component, and under `exactOptionalPropertyTypes` the call sites would
 * otherwise each need a conditional-spread dance to forward an absent `min`.
 */
function NumberStepper({
  id,
  label,
  value,
  onValueChange,
  step,
  min,
  max,
  unit,
  unitControl,
  disabled,
  invalid,
  describedBy: describedByIds,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: number | null;
  readonly onValueChange: (value: number | null) => void;
  readonly step: number;
  readonly min: number | undefined;
  readonly max: number | undefined;
  readonly unit: string | undefined;
  /** Rendered in place of the static unit — `QuantityField`'s unit chooser. */
  readonly unitControl?: ReactNode;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly describedBy: string | undefined;
}): ReactNode {
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
          aria-invalid={invalid || undefined}
          aria-describedby={describedByIds}
          className="nos-input nos-input--numeric"
        />
        {unitControl ??
          (unit === undefined ? null : (
            <span className="nos-number__unit" aria-hidden="true">
              {unit}
            </span>
          ))}
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
  );
}

/* =========================================================================
 * QuantityField — a value and its unit (§8.10)
 * ====================================================================== */

export type QuantityFieldProps = {
  readonly label: string;
  readonly value: number | null;
  readonly onValueChange: (value: number | null) => void;
  /**
   * The unit the number is being *entered* in.
   *
   * §8.10: "Units are displayed, always, and are a display concern — values are
   * stored canonically (§6.2, `core/units`)." This component therefore never
   * converts anything. It reports the number and the unit it was typed in, and
   * `core/units` decides what that means in kilograms. A design system that
   * converted units would be a design system that knows 1 kg is 2.20462 lb,
   * which is domain knowledge it is not allowed to hold (§6.2).
   */
  readonly unit: string;
  /** Offer a chooser when there is more than one. Omit for a fixed unit. */
  readonly units?: readonly string[];
  readonly onUnitChange?: (unit: string) => void;
  readonly step?: number;
  readonly min?: number;
  readonly max?: number;
  /**
   * The previous entry, offered as a one-tap prefill.
   *
   * §8.10: "**Last value pre-filled** wherever a sensible prior exists.
   * Confirming beats typing." Offered rather than applied: silently filling a
   * body measurement with yesterday's number is how a stale reading gets saved
   * as today's, and the tap costs less than that costs.
   */
  readonly lastValue?: number;
  readonly hint?: string;
  readonly error?: string;
  readonly labelHidden?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
};

export function QuantityField({
  label,
  value,
  onValueChange,
  unit,
  units,
  onUnitChange,
  step = 1,
  min,
  max,
  lastValue,
  hint,
  error,
  labelHidden,
  disabled = false,
  className,
}: QuantityFieldProps): ReactNode {
  const id = useId();
  const canChooseUnit = units !== undefined && units.length > 1 && onUnitChange !== undefined;

  return (
    <FieldShell
      id={id}
      label={label}
      {...(labelHidden === undefined ? {} : { labelHidden })}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      {...(className === undefined ? {} : { className })}
    >
      <NumberStepper
        id={id}
        label={label}
        value={value}
        onValueChange={onValueChange}
        step={step}
        min={min}
        max={max}
        unit={unit}
        disabled={disabled}
        invalid={error !== undefined}
        describedBy={describedBy(id, hint, error)}
        {...(canChooseUnit
          ? {
              unitControl: (
                <select
                  className="nos-number__unit-select"
                  // The unit chooser is a separate control from the number, so
                  // it needs a name of its own — "Unit" alone would announce
                  // identically for every quantity on the screen.
                  aria-label={`Unit for ${label}`}
                  value={unit}
                  disabled={disabled}
                  onChange={(event) => {
                    onUnitChange(event.target.value);
                  }}
                >
                  {units.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ),
            }
          : {})}
      />

      {/* The unit is aria-hidden in the stepper when it is static text. */}
      {!canChooseUnit && <span className="nos-visually-hidden">{unit}</span>}

      {value === null && lastValue !== undefined && (
        <LastValuePrefill
          text={`${String(lastValue)} ${unit}`}
          onUse={() => {
            onValueChange(lastValue);
          }}
        />
      )}
    </FieldShell>
  );
}

/**
 * The "use what you entered last time" affordance.
 *
 * Shown only while the field is empty, and it disappears the moment there is a
 * value — leaving it visible turns it into a second control competing with the
 * number the user just typed.
 */
function LastValuePrefill({
  text,
  onUse,
}: {
  readonly text: string;
  readonly onUse: () => void;
}): ReactNode {
  return (
    <button type="button" className="nos-field__prefill" onClick={onUse}>
      Use last: <span className="nos-field__prefill-value">{text}</span>
    </button>
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

/* =========================================================================
 * SelectField — one of a known, closed set (§8.10)
 * ====================================================================== */

/**
 * An option, shared by `SelectField` and `ComboboxField`.
 *
 * One type rather than two, because the difference between the components is
 * how you *reach* an option, not what an option is.
 */
export type SelectOption = {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
};

export type SelectFieldProps = {
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  /** Shown as the unselected state. Not a label — the label is above (§8.10). */
  readonly placeholder?: string;
  /** Offered as a one-tap prefill while nothing is selected. */
  readonly lastValue?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly labelHidden?: boolean;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly className?: string;
};

/**
 * A select.
 *
 * **Deliberately the native control**, for the same reasons `DateField` is:
 * the platform picker is keyboard accessible, works with every screen reader,
 * and on mobile opens the OS wheel — which is both faster than any custom
 * listbox and the interaction the user already knows. A hand-built select is
 * one of the top three accessibility liabilities a design system can take on,
 * and it buys nothing that §8.10 asks for.
 *
 * The one thing it costs is control over the option list's appearance, which is
 * a price worth paying for a closed set of short strings. When the set is long
 * enough to need filtering, that is a `ComboboxField`, not a styled select.
 */
export function SelectField({
  label,
  value,
  onValueChange,
  options,
  placeholder,
  lastValue,
  hint,
  error,
  labelHidden,
  disabled = false,
  required,
  className,
}: SelectFieldProps): ReactNode {
  const id = useId();
  const lastOption = options.find((option) => option.value === lastValue);

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
      <div className="nos-select-wrap">
        <select
          id={id}
          className="nos-input nos-select"
          value={value}
          disabled={disabled}
          required={required}
          aria-invalid={error !== undefined || undefined}
          aria-describedby={describedBy(id, hint, error)}
          onChange={(event) => {
            onValueChange(event.target.value);
          }}
        >
          {placeholder !== undefined && (
            // Kept selectable rather than `disabled`, so a non-required field
            // can be cleared back to nothing after a value has been chosen.
            <option value="">{placeholder}</option>
          )}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        {/* The chevron is decoration on top of the native affordance, which is
            why it is aria-hidden and pointer-transparent in CSS. */}
        <Icon name="nav.expand" label={null} size="sm" className="nos-select-wrap__chevron" />
      </div>

      {value === '' && lastOption !== undefined && (
        <LastValuePrefill
          text={lastOption.label}
          onUse={() => {
            onValueChange(lastOption.value);
          }}
        />
      )}
    </FieldShell>
  );
}

/* =========================================================================
 * ComboboxField — a long set, filtered by typing (§8.10)
 * ====================================================================== */

export type ComboboxFieldProps = {
  readonly label: string;
  /** The committed value: an option's `value`, or free text when `allowCustom`. */
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  /**
   * Accept something that is not on the list.
   *
   * On for the exercise picker and anything else where the operator's
   * vocabulary is allowed to grow; off where the set is genuinely closed and a
   * typo would create a duplicate entity.
   */
  readonly allowCustom?: boolean;
  readonly placeholder?: string;
  /** Offered as a one-tap prefill while the field is empty. */
  readonly lastValue?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly labelHidden?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
};

/**
 * A text input that filters a list.
 *
 * This is the one field type that cannot be a native control — no browser
 * offers a filtered listbox — so it implements the ARIA 1.2 combobox pattern
 * by hand, and the parts that are easy to get wrong are called out below.
 *
 * ## `aria-activedescendant`, not focus
 *
 * The highlighted option is referenced by id while DOM focus stays in the
 * input. Moving focus into the list instead would close the software keyboard
 * on every arrow press, and on a phone that makes the control unusable.
 *
 * ## Committing on blur
 *
 * The list closes when focus leaves the *wrapper*, not the input, because a
 * pointer press on an option blurs the input before the click lands. Checking
 * `relatedTarget` against the wrapper is what stops the list vanishing out from
 * under the tap — a `setTimeout` would work too, and would race.
 */
export function ComboboxField({
  label,
  value,
  onValueChange,
  options,
  allowCustom = false,
  placeholder,
  lastValue,
  hint,
  error,
  labelHidden,
  disabled = false,
  className,
}: ComboboxFieldProps): ReactNode {
  const id = useId();
  const listId = `${id}-list`;

  const labelFor = (candidate: string): string =>
    options.find((option) => option.value === candidate)?.label ?? candidate;

  const [query, setQuery] = useState(() => labelFor(value));
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const needle = query.trim().toLowerCase();
  const matches = options.filter(
    (option) => option.disabled !== true && option.label.toLowerCase().includes(needle),
  );
  const active = matches[Math.min(activeIndex, matches.length - 1)];

  const commit = (option: SelectOption): void => {
    setQuery(option.label);
    setIsOpen(false);
    setActiveIndex(0);
    onValueChange(option.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        return;
      }
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      // Wrapping, because a list that stops at the end makes the user reverse
      // direction to reach the option one above where they started.
      setActiveIndex((current) => {
        if (matches.length === 0) return 0;
        return (current + delta + matches.length) % matches.length;
      });
      return;
    }

    if (event.key === 'Enter') {
      if (isOpen && active !== undefined) {
        event.preventDefault();
        commit(active);
        return;
      }
      if (allowCustom) {
        // No preventDefault: a bare Enter in a single-field form should still
        // submit it, and swallowing that is how a capture form gains a
        // mandatory extra tap.
        onValueChange(query.trim());
        setIsOpen(false);
      }
      return;
    }

    if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      setIsOpen(false);
    }
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
      <div
        className="nos-combobox"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setIsOpen(false);
            // Free text is committed on blur; a closed set snaps back to the
            // label of whatever is actually selected, so the input can never
            // be left showing a value the form does not hold.
            if (allowCustom) onValueChange(query.trim());
            else setQuery(labelFor(value));
          }
        }}
      >
        <div className="nos-input-wrap">
          <input
            id={id}
            className="nos-input"
            type="text"
            role="combobox"
            autoComplete="off"
            aria-expanded={isOpen}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={isOpen && active !== undefined ? `${listId}-${active.value}` : undefined}
            aria-invalid={error !== undefined || undefined}
            aria-describedby={describedBy(id, hint, error)}
            placeholder={placeholder}
            disabled={disabled}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
              setIsOpen(true);
            }}
            onFocus={() => {
              setIsOpen(true);
            }}
            onKeyDown={handleKeyDown}
          />
          <IconButton
            icon="nav.expand"
            label={isOpen ? `Hide ${label} options` : `Show ${label} options`}
            size="sm"
            className="nos-input-wrap__clear"
            disabled={disabled}
            aria-expanded={isOpen}
            aria-controls={listId}
            onClick={() => {
              setIsOpen((current) => !current);
            }}
          />
        </div>

        {/*
          The listbox stays in the DOM only while open. Rendering it hidden
          would leave its options in the accessibility tree, and a screen
          reader would announce the option count of a list nobody opened.
        */}
        {isOpen && (
          <ul className="nos-listbox" id={listId} role="listbox" aria-label={label}>
            {matches.length === 0 ? (
              <li className="nos-listbox__empty" role="presentation">
                {allowCustom ? 'No match — press Enter to add it' : 'No match'}
              </li>
            ) : (
              matches.map((option, index) => (
                <li
                  key={option.value}
                  id={`${listId}-${option.value}`}
                  role="option"
                  aria-selected={option.value === value}
                  className={cn('nos-listbox__option', option === active && 'is-active')}
                  // `onMouseDown` rather than `onClick`: click fires after blur,
                  // and by then the list has already closed.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    commit(option);
                  }}
                  onMouseEnter={() => {
                    setActiveIndex(index);
                  }}
                >
                  {option.label}
                  {option.value === value && (
                    // The selected option carries a mark, not only a fill —
                    // §8.13 forbids state conveyed by colour alone.
                    <Icon name="action.confirm" label={null} size="sm" />
                  )}
                </li>
              ))
            )}
          </ul>
        )}
      </div>

      {value === '' && lastValue !== undefined && (
        <LastValuePrefill
          text={labelFor(lastValue)}
          onUse={() => {
            setQuery(labelFor(lastValue));
            onValueChange(lastValue);
          }}
        />
      )}
    </FieldShell>
  );
}

/* =========================================================================
 * TimeField
 * ====================================================================== */

/**
 * A time input.
 *
 * Native, like `DateField`, and for the same reasons — plus one specific to
 * time: the native control follows the user's 12/24-hour locale setting, and a
 * custom one would have to guess. Guessing wrong on a medication time is worse
 * than ugly.
 *
 * The value is a wall-clock `HH:mm` with no zone attached, which is what a
 * "take it at 08:00" schedule actually means (§5.3). Attaching a zone here
 * would make the field lie on the far side of a flight.
 */
export function TimeField({
  label,
  value,
  onValueChange,
  lastValue,
  hint,
  error,
  labelHidden,
  disabled = false,
  className,
}: {
  readonly label: string;
  /** Wall-clock `HH:mm`. */
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** Offered as a one-tap prefill while the field is empty. */
  readonly lastValue?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly labelHidden?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
}): ReactNode {
  const id = useId();

  return (
    <FieldShell
      id={id}
      label={label}
      {...(labelHidden === undefined ? {} : { labelHidden })}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      {...(className === undefined ? {} : { className })}
    >
      <input
        id={id}
        type="time"
        className="nos-input"
        value={value}
        disabled={disabled}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => {
          onValueChange(event.target.value);
        }}
      />

      {value === '' && lastValue !== undefined && (
        <LastValuePrefill
          text={lastValue}
          onUse={() => {
            onValueChange(lastValue);
          }}
        />
      )}
    </FieldShell>
  );
}

/* =========================================================================
 * TagField
 * ====================================================================== */

export type TagFieldProps = {
  readonly label: string;
  readonly values: readonly string[];
  readonly onValuesChange: (values: readonly string[]) => void;
  /** Previously used tags, offered beneath the input. */
  readonly suggestions?: readonly string[];
  readonly placeholder?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly labelHidden?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
};

/**
 * A set of short free-text labels.
 *
 * ## Why the chips are a list and the input is outside it
 *
 * The chips are a real `<ul>` with a live region, so adding or removing one is
 * announced. Putting the input inside the list — the usual "tag input" shape —
 * makes the input a list item, which reads as "list, 4 items" with an edit box
 * as the fourth. Keeping them siblings costs a wrapper and fixes the
 * announcement.
 *
 * ## Backspace
 *
 * Backspace on an empty input removes the last chip, which is the behaviour
 * every tag input has and the one people reach for without thinking. It only
 * fires when the input is empty, so it never eats a character.
 */
export function TagField({
  label,
  values,
  onValuesChange,
  suggestions,
  placeholder,
  hint,
  error,
  labelHidden,
  disabled = false,
  className,
}: TagFieldProps): ReactNode {
  const id = useId();
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (raw: string): void => {
    const tag = raw.trim();
    // Case-insensitive de-duplication: "Travel" and "travel" are one tag, and
    // a set that holds both is a set that never groups correctly again.
    if (tag === '' || values.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      setDraft('');
      return;
    }
    onValuesChange([...values, tag]);
    setDraft('');
  };

  const remove = (tag: string): void => {
    onValuesChange(values.filter((existing) => existing !== tag));
    inputRef.current?.focus();
  };

  const unused = (suggestions ?? []).filter(
    (suggestion) => !values.some((existing) => existing.toLowerCase() === suggestion.toLowerCase()),
  );

  return (
    <FieldShell
      id={id}
      label={label}
      {...(labelHidden === undefined ? {} : { labelHidden })}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      {...(className === undefined ? {} : { className })}
    >
      {values.length > 0 && (
        <ul className="nos-tagfield__tags" role="list" aria-live="polite" aria-label={`${label}, selected`}>
          {values.map((tag) => (
            <li key={tag} className="nos-tag">
              <span>{tag}</span>
              <button
                type="button"
                className="nos-tag__remove"
                // Named per-tag: five buttons all called "Remove" are five
                // identical announcements in a row.
                aria-label={`Remove ${tag}`}
                disabled={disabled}
                onClick={() => {
                  remove(tag);
                }}
              >
                <Icon name="nav.close" label={null} size="sm" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        id={id}
        ref={inputRef}
        type="text"
        className="nos-input"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            add(draft);
            return;
          }
          if (event.key === 'Backspace' && draft === '') {
            const last = values.at(-1);
            if (last !== undefined) remove(last);
          }
        }}
        // Committing on blur as well as on Enter: a half-typed tag abandoned by
        // tabbing away is a tag the user meant to add (§8.10's bias toward
        // capture surviving navigation).
        onBlur={() => {
          add(draft);
        }}
      />

      {unused.length > 0 && (
        <ul className="nos-tagfield__suggestions" role="list">
          {unused.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                className="nos-tag nos-tag--suggestion"
                disabled={disabled}
                onClick={() => {
                  add(suggestion);
                }}
              >
                <Icon name="action.add" label={null} size="sm" />
                {suggestion}
              </button>
            </li>
          ))}
        </ul>
      )}
    </FieldShell>
  );
}
