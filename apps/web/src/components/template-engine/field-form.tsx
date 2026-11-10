'use client';

/**
 * Dynamic agreement field form: renders whatever the selected template
 * defines, applying conditional visibility, grouping, guidance text,
 * required markers, and per-field validation from the shared engine.
 */
import { useMemo } from 'react';
import {
  validateValues,
  visibleFields,
} from '@agreementhub/domain/template';
import { FieldInput } from './field-input';
import type { TemplateDefinition, TemplateValues } from '@/lib/types';

export function DynamicFieldForm({
  definition,
  values,
  onChange,
  showRequiredErrors = false,
}: {
  definition: TemplateDefinition;
  values: TemplateValues;
  onChange: (code: string, value: string) => void;
  /** After a save/generate attempt, also surface missing-required messages. */
  showRequiredErrors?: boolean;
}) {
  const visible = useMemo(() => visibleFields(definition, values), [definition, values]);
  const issues = useMemo(() => validateValues(definition, values), [definition, values]);

  const issueByCode = new Map(issues.map((i) => [i.code, i]));

  // Preserve definition order; consecutive same-group fields share a heading.
  const groups: Array<{ name: string | null; fields: typeof visible }> = [];
  for (const field of visible) {
    const group = field.group ?? null;
    const last = groups[groups.length - 1];
    if (last && last.name === group) last.fields.push(field);
    else groups.push({ name: group, fields: [field] });
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-ink-2">
        <span className="text-danger">*</span> Required fields must be completed before this
        agreement can move to signatures or be finalized. Sections that depend on a condition
        appear as you answer.
      </p>
      {groups.map((group, index) => (
        <div key={group.name ?? `group-${index}`}>
          {group.name ? (
            <h3 className="text-xs font-semibold tracking-wider text-ink-3 uppercase">
              {group.name}
            </h3>
          ) : null}
          <div
            className={[
              'mt-3 grid gap-4',
              group.fields.length > 1 ? 'sm:grid-cols-2' : '',
            ].join(' ')}
          >
            {group.fields.map((field) => {
              const issue = issueByCode.get(field.code);
              const errorText = issue
                ? issue.kind === 'format' || showRequiredErrors
                  ? issue.message
                  : null
                : null;
              return (
                <div
                  key={field.code}
                  className={field.type === 'textarea' ? 'sm:col-span-2' : ''}
                >
                  <FieldInput
                    field={field}
                    value={values[field.code] == null ? '' : String(values[field.code])}
                    error={errorText}
                    values={values}
                    definition={definition}
                    onChange={(v) => onChange(field.code, v)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
