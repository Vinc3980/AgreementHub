'use client';

/**
 * Renders a single template field definition as the matching input control.
 * Purely data-driven: the template definition decides the control type,
 * label, guidance text, options, and required marker.
 *
 * Money fields: accept/strip pasted currency symbols/codes, format with
 * thousands separators on blur, reject negatives/non-numbers/>2 decimals with
 * an inline error, and show a read-only amount-in-words hint (ISO code +
 * words, safe in all fonts). Currency symbol display (₵) is avoided in form
 * inputs/hints to prevent tofu in fonts that lack U+20B5; documents use ISO
 * codes (handled by the render pipeline).
 *
 * Ghana phone fields (format: ghana_phone): accept local/international forms;
 * engine validation enforces format.
 * Ghana Post GPS (format: ghana_post_gps): validates AA(A)-123(4)-1234.
 */
import { useMemo, useState } from 'react';
import { Input, Select, Textarea } from '@/components/ui/field';
import { SearchableSelect } from '@/components/ui/searchable-select';
import {
  amountInWords,
  isValidGhanaPhone,
  normalizeGhanaPhone,
  parseMoneyAmount,
  validateMoneyValue,
} from '@agreementhub/domain/currency';
import { isValidGhanaPostGps, normalizeGhanaPostGps } from '@agreementhub/domain/location';
import { resolveCurrencyCode } from '@agreementhub/domain/template';
import type { TemplateDefinition, TemplateFieldDef, TemplateValues } from '@/lib/types';

function isCountryLikeSelect(field: TemplateFieldDef): boolean {
  if (field.type !== 'select') return false;
  if (/country/i.test(field.code) || /country/i.test(field.label)) return true;
  return (field.options?.length ?? 0) > 20;
}

/** Strip currency symbols/codes for editing; keep digits, separators, sign, dot. */
function stripMoneyNoise(raw: string): string {
  return raw
    .replace(/GH₵|GH¢|GHC|GHS|USD|GBP|EUR|NGN|XOF|CAD|AUD|INR/gi, '')
    .replace(/[₵¢$£€₦₹\s]/g, '');
}

/** Group thousands for display on blur (preserve up to 2 decimals, no forced .00). */
function formatMoneyDisplay(raw: string): string {
  const n = parseMoneyAmount(raw);
  if (n === null) return raw;
  // Determine decimal digits the user entered (capped at 2 for display grouping).
  const cleaned = String(raw).replace(/[^0-9.-]/g, '');
  const dot = cleaned.indexOf('.');
  const decimals = dot >= 0 ? Math.min(2, cleaned.length - dot - 1) : 0;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: true,
  }).format(n);
}

export function FieldInput({
  field,
  value,
  error,
  values,
  definition,
  onChange,
}: {
  field: TemplateFieldDef;
  value: string;
  error?: string | null;
  values?: TemplateValues;
  definition?: TemplateDefinition;
  onChange: (value: string) => void;
}) {
  const [moneyEditing, setMoneyEditing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const currencyCode = useMemo(() => {
    if (field.type !== 'money' || !definition || !values) return null;
    return resolveCurrencyCode(field, definition, values);
  }, [field, definition, values]);

  const amountWordsHint = useMemo(() => {
    if (field.type !== 'money') return null;
    const n = parseMoneyAmount(value);
    if (n === null) return null;
    const code = currencyCode ?? 'USD';
    try {
      return amountInWords(n, code);
    } catch {
      return null;
    }
  }, [field.type, value, currencyCode]);

  const guidanceHint = field.guidance;
  const mergedError = error ?? localError;

  if (field.type === 'money') {
    const hintParts = [guidanceHint, amountWordsHint].filter(Boolean);
    const hintNode =
      hintParts.length > 0 ? (
        <span className="flex flex-col gap-0.5">
          {guidanceHint ? <span>{guidanceHint}</span> : null}
          {amountWordsHint ? (
            <span className="text-ink-2" aria-live="polite">
              {amountWordsHint}
            </span>
          ) : null}
        </span>
      ) : (
        'Numbers only, e.g. 5,000 or 5000.50'
      );

    return (
      <Input
        label={field.label}
        required={field.required === true}
        value={value}
        hint={hintNode}
        error={mergedError}
        placeholder={field.placeholder ?? 'e.g. 5,000.00'}
        type="text"
        inputMode="decimal"
        onFocus={() => setMoneyEditing(true)}
        onChange={(e) => {
          const stripped = stripMoneyNoise(e.target.value);
          // Keep only characters meaningful for a money amount while typing.
          const cleaned = stripped.replace(/[^0-9.,-]/g, '');
          setLocalError(validateMoneyValue(cleaned, 2) ? `${field.label} ${validateMoneyValue(cleaned, 2)}.` : null);
          onChange(cleaned);
        }}
        onBlur={() => {
          setMoneyEditing(false);
          const err = validateMoneyValue(value, 2);
          setLocalError(err ? `${field.label} ${err}.` : null);
          if (!err && value.trim() !== '') {
            const n = parseMoneyAmount(value);
            if (n !== null) onChange(formatMoneyDisplay(String(n)));
          } else if (value.trim() !== '' && parseMoneyAmount(value) !== null) {
            // Has parseable number but other validation issue (e.g. decimals) - keep as-is.
          }
        }}
      />
    );
  }

  if (field.format === 'ghana_phone') {
    const hintNode = (
      <span className="flex flex-col gap-0.5">
        {guidanceHint ? <span>{guidanceHint}</span> : <span>Ghana mobile number (e.g. 024 123 4567 or +233 24 123 4567).</span>}
      </span>
    );
    return (
      <Input
        label={field.label}
        required={field.required === true}
        value={value}
        hint={hintNode}
        error={mergedError}
        placeholder={field.placeholder ?? '024 123 4567'}
        type="tel"
        inputMode="tel"
        onChange={(e) => {
          const v = e.target.value;
          if (v.trim() && !isValidGhanaPhone(v) && /[^\d\s\-+().]/.test(v)) {
            setLocalError(`${field.label} contains invalid characters.`);
          } else {
            setLocalError(null);
          }
          onChange(v);
        }}
        onBlur={() => {
          if (value.trim() && !isValidGhanaPhone(value)) {
            setLocalError(`${field.label} must be a valid Ghana phone number (e.g. 024 123 4567 or +233 24 123 4567).`);
          } else {
            setLocalError(null);
            const norm = normalizeGhanaPhone(value);
            if (norm) onChange(norm);
          }
        }}
      />
    );
  }

  if (field.format === 'ghana_post_gps') {
    return (
      <Input
        label={field.label}
        required={field.required === true}
        value={value}
        hint={guidanceHint ?? 'Ghana Post GPS digital address (e.g. GA-123-4567).'}
        error={mergedError}
        placeholder={field.placeholder ?? 'GA-123-4567'}
        type="text"
        className="font-mono"
        onChange={(e) => {
          const v = e.target.value.toUpperCase();
          if (v.trim() && !isValidGhanaPostGps(v) && v.length >= 5) {
            setLocalError(`${field.label} must be a valid Ghana Post GPS address (e.g. GA-123-4567).`);
          } else {
            setLocalError(null);
          }
          onChange(v);
        }}
        onBlur={() => {
          if (value.trim() && !isValidGhanaPostGps(value)) {
            setLocalError(`${field.label} must be a valid Ghana Post GPS address (e.g. GA-123-4567).`);
          } else {
            setLocalError(null);
            const norm = normalizeGhanaPostGps(value);
            if (norm) onChange(norm);
          }
        }}
      />
    );
  }

  const hint = field.guidance;
  const common = {
    label: field.label,
    required: field.required === true,
    value,
    hint,
    error: mergedError,
    placeholder: field.placeholder,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  };

  switch (field.type) {
    case 'textarea':
      return <Textarea {...common} rows={4} />;
    case 'select':
      if (isCountryLikeSelect(field)) {
        return (
          <SearchableSelect
            label={field.label}
            required={field.required === true}
            value={value}
            hint={field.guidance}
            error={mergedError}
            placeholder={field.placeholder ?? 'Search…'}
            options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
            onChange={onChange}
          />
        );
      }
      return (
        <Select {...common}>
          <option value="">Choose…</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      );
    case 'toggle':
      return (
        <Select {...common}>
          <option value="">Choose…</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
        </Select>
      );
    case 'date':
      return <Input {...common} type="date" />;
    case 'number':
      return <Input {...common} type="number" inputMode="numeric" />;
    case 'email':
      return <Input {...common} type="email" />;
    default:
      return <Input {...common} type="text" />;
  }
}
