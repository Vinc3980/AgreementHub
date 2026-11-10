'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AsYouType,
  getCountries as getPhoneCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/min';
import { Field } from './field';

const CONTROL =
  'block min-h-11 rounded-control border border-rule-strong bg-sheet px-3 py-2 text-sm text-ink ' +
  'placeholder:text-ink-3 transition-colors duration-[var(--duration-ui)] ' +
  'hover:border-ink-3 focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/30 ' +
  'disabled:cursor-not-allowed disabled:bg-vellum disabled:text-ink-2';

const NEIGHBOURS = ['CI', 'TG', 'BF', 'NG'];

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function callingOptions(): Array<{ country: string; dial: string; label: string }> {
  try {
    const codes = getPhoneCountries();
    const opts = codes.map((c) => ({
      country: c,
      dial: `+${getCountryCallingCode(c)}`,
      label: `${countryName(c)} (${`+${getCountryCallingCode(c)}`})`,
    }));
    opts.sort((a, b) => {
      if (a.country === 'GH') return -1;
      if (b.country === 'GH') return 1;
      const aN = NEIGHBOURS.indexOf(a.country);
      const bN = NEIGHBOURS.indexOf(b.country);
      if (aN >= 0 || bN >= 0) return (aN < 0 ? 999 : aN) - (bN < 0 ? 999 : bN);
      return a.label.localeCompare(b.label, 'en');
    });
    return opts;
  } catch {
    return [{ country: 'GH', dial: '+233', label: 'Ghana (+233)' }];
  }
}

function formatDisplay(value: string, defaultCountry: CountryCode): string {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  try {
    const pn = parsePhoneNumberFromString(raw.replace(/[\s\-().\u00A0]/g, ''), defaultCountry);
    if (pn && pn.isValid()) return pn.formatNational();
  } catch {
    /* fall through */
  }
  return raw;
}

export function PhoneField({
  label = 'Phone',
  hint,
  error,
  required,
  value,
  onChange,
  defaultCountry = 'GH',
}: {
  label?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  /** Stored value (E.164 preferred) or raw input. */
  value: string;
  onChange: (value: string) => void;
  /** ISO country code used when number has no international prefix. */
  defaultCountry?: string;
}) {
  const options = useMemo(() => callingOptions(), []);
  const [country, setCountry] = useState<CountryCode>((defaultCountry.toUpperCase() as CountryCode) || 'GH');
  const [text, setText] = useState(() => formatDisplay(value, country));
  const [focused, setFocused] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Sync display when external value changes (e.g. session load).
  useEffect(() => {
    if (focused) return;
    try {
      const clean = (value ?? '').replace(/[\s\-().\u00A0]/g, '');
      if (clean) {
        const pn = parsePhoneNumberFromString(clean, country);
        if (pn?.isValid()) {
          if (pn.country) setCountry(pn.country);
          setText(pn.formatNational());
          setLocalError(null);
          return;
        }
      }
    } catch {
      /* ignore */
    }
    setText(formatDisplay(value ?? '', country));
  }, [value, country, focused]);

  function emit(raw: string, cc: CountryCode) {
    const cleaned = raw.replace(/[\s\-().\u00A0]/g, '');
    if (!cleaned) {
      setLocalError(null);
      onChange('');
      return;
    }
    try {
      const pn = parsePhoneNumberFromString(cleaned, cc);
      if (pn?.isValid()) {
        setLocalError(null);
        if (pn.country) setCountry(pn.country);
        onChange(pn.number); // E.164
        return;
      }
    } catch {
      /* ignore */
    }
    // Keep raw so user can keep typing; server will validate on submit.
    setLocalError(raw.trim() ? 'Enter a valid phone number.' : null);
    onChange(raw.trim());
  }

  const mergedError = error ?? localError;
  const dial = options.find((o) => o.country === country)?.dial ?? '+233';

  return (
    <Field label={label} hint={hint ?? `Default ${dial}. You can enter a local number (e.g. 024 123 4567) or an international number.`} error={mergedError} required={required}>
      <div className="flex items-stretch gap-2">
        <select
          aria-label="Country calling code"
          className={`${CONTROL} w-[7.5rem] shrink-0 sm:w-[8.25rem]`}
          value={country}
          onChange={(e) => {
            const cc = e.target.value as CountryCode;
            setCountry(cc);
            if (text.trim()) {
              const ayt = new AsYouType(cc);
              ayt.input(text);
              emit(text, cc);
            }
          }}
        >
          {options.map((o) => (
            <option key={o.country} value={o.country}>
              {o.dial} {o.country}
            </option>
          ))}
        </select>
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          className={`${CONTROL} min-w-0 flex-1 ${mergedError ? 'border-danger' : ''}`}
          placeholder={country === 'GH' ? '024 123 4567' : 'Phone number'}
          value={text}
          onFocus={() => setFocused(true)}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            emit(v, country);
          }}
          onBlur={() => {
            setFocused(false);
            setText(formatDisplay(value || text, country));
            // re-validate on blur
            emit(text, country);
          }}
        />
      </div>
    </Field>
  );
}
