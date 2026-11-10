'use client';

/**
 * Template preview panel for the new-agreement flow: shows what the chosen
 * template will ask for (fields, required markers, conditional items) and
 * which document sections it produces. All of this is read from the engine definition.
 */
import { parseTemplateDefinition } from '@agreementhub/domain/template';
import { useTemplateDefinition } from '@/lib/queries';
import { useDelayedPending } from '@/lib/use-delayed-pending';
import { Badge } from '@/components/ui/badge';

export function TemplateSummary({ templateId }: { templateId: string }) {
  const query = useTemplateDefinition(templateId);
  const showPending = useDelayedPending(query.isPending && !query.data);
  const definition = query.data
    ? parseTemplateDefinition(query.data.template.content_schema)
    : null;

  if (query.isPending) {
    if (!showPending) return <div className="min-h-[4rem]" aria-busy="true" aria-live="polite" />;
    return <p className="text-sm text-ink-2">Loading template structure…</p>;
  }
  if (!definition) {
    return (
      <p className="text-sm text-attention">
        This template’s structure could not be loaded. You can still create the agreement and edit
        its sections manually.
      </p>
    );
  }

  const requiredCount = definition.fields.filter((f) => f.required === true).length;
  const conditionalCount =
    definition.sections.filter((s) => s.showIf).length +
    definition.fields.filter((f) => f.showIf).length;

  return (
    <div className="grid gap-6 sm:grid-cols-2 content-fade-in">
      <div>
        <h3 className="text-xs font-semibold tracking-wider text-ink-3 uppercase">
          What you will fill in
        </h3>
        <ul className="mt-2 space-y-1.5">
          {definition.fields.map((field) => (
            <li key={field.code} className="flex flex-wrap items-center gap-2 text-sm text-ink">
              <span>{field.label}</span>
              {field.required === true ? (
                <span className="text-xs text-danger">required</span>
              ) : (
                <span className="text-xs text-ink-2">optional</span>
              )}
              {field.showIf ? <Badge tone="info">conditional</Badge> : null}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="text-xs font-semibold tracking-wider text-ink-3 uppercase">
          Document sections
        </h3>
        <ol className="mt-2 space-y-1.5">
          {definition.sections
            .slice()
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((section, index) => (
              <li key={section.code} className="flex flex-wrap items-center gap-2 text-sm text-ink">
                <span className="w-5 shrink-0 text-right text-xs text-ink-3">{index + 1}.</span>
                <span>{section.title}</span>
                {section.showIf ? <Badge tone="info">conditional</Badge> : null}
              </li>
            ))}
        </ol>
        <p className="mt-3 text-xs text-ink-2">
          {requiredCount} required field{requiredCount === 1 ? '' : 's'} of {definition.fields.length}{' '}
          total · {conditionalCount} conditional item{conditionalCount === 1 ? '' : 's'}
        </p>
      </div>
    </div>
  );
}
