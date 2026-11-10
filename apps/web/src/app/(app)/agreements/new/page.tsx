'use client';

/** New agreement: pick a template, name it, optionally set an expiry date. */
import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, FileSignature, Users } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { CardSkeleton, ErrorState, LoadingStatus } from '@/components/ui/states';
import { TemplateSummary } from '@/components/template-engine/template-summary';
import { AssistantPanel, type AcceptedField } from '@/components/ai/assistant-panel';
import { useTemplateCategories, useTemplates } from '@/lib/queries';
import { useDelayedPending } from '@/lib/use-delayed-pending';
import { useToast } from '@/lib/toast';
import { ApiError, patch, post } from '@/lib/api';
import { formatDateLong } from '@/lib/format';
import type { AgreementListItem, TemplateListItem } from '@/lib/types';

/** Default title shown when a template is selected. */
function defaultTitle(template: TemplateListItem): string {
  return `${template.name} — ${new Date().getFullYear()}`;
}

/** The API accepts a date; the agreement expires at the end of that day. */
function expiryIso(date: string): string {
  return `${date}T23:59:59.999Z`;
}

function isPastExpiry(date: string): boolean {
  return new Date(expiryIso(date)).getTime() < Date.now();
}

export default function NewAgreementPage() {
  const router = useRouter();
  const toast = useToast();

  const categoriesQuery = useTemplateCategories();
  const [category, setCategory] = useState('');
  const templatesQuery = useTemplates(category || undefined);
  const showTemplatesPending = useDelayedPending(
    (templatesQuery.isPending || categoriesQuery.isPending) && !templatesQuery.data,
  );

  const [templateId, setTemplateId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  // Once the user edits the title, selecting another template must not replace it.
  const [titleTouched, setTitleTouched] = useState(false);
  const [brief, setBrief] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Suggestions the user explicitly accepted in the assistant panel; applied
  // (with provenance AI_SUGGESTED_CONFIRMED) right after creation.
  const [acceptedFields, setAcceptedFields] = useState<AcceptedField[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);
  const expiryRef = useRef<HTMLInputElement>(null);
  // Mobile (<768px): show one step at a time with a sticky action in the thumb zone.
  const [mobileStep, setMobileStep] = useState<1 | 2>(1);

  const selectedTemplate = templatesQuery.data?.templates.find((t) => t.id === templateId) ?? null;

  function clearFieldError(key: string) {
    setFieldErrors((previous) => {
      if (!previous[key]) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }

  function selectTemplate(template: TemplateListItem) {
    setTemplateId(template.id);
    setError(null);
    clearFieldError('templateId');
    if (!titleTouched) {
      setTitle(defaultTitle(template));
      clearFieldError('title');
    }
  }

  function validateTitle(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return 'Give your agreement a title';
    if (trimmed.length > 300) return 'Keep the title to 300 characters or fewer.';
    return null;
  }

  function onTitleChange(value: string) {
    setTitle(value);
    setTitleTouched(true);
    setError(null);
    const titleError = validateTitle(value);
    if (titleError) {
      setFieldErrors((previous) => ({ ...previous, title: titleError }));
    } else {
      clearFieldError('title');
    }
  }

  function onExpiryChange(value: string) {
    setExpiresAt(value);
    setError(null);
    if (value && isPastExpiry(value)) {
      setFieldErrors((previous) => ({ ...previous, expiresAt: 'Choose a future date' }));
    } else {
      clearFieldError('expiresAt');
    }
  }

  function onCategoryChange(value: string) {
    setCategory(value);
    setTemplateId(null);
    setError(null);
    clearFieldError('templateId');
    // A title default belongs to its template; drop it when no template is selected.
    if (!titleTouched) setTitle('');
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    const nextErrors: Record<string, string> = {};
    const titleError = validateTitle(title);
    if (titleError) nextErrors.title = titleError;
    if (!templateId) nextErrors.templateId = 'Choose a template to continue.';
    if (expiresAt && isPastExpiry(expiresAt)) nextErrors.expiresAt = 'Choose a future date';

    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      if (nextErrors.title) titleRef.current?.focus();
      else if (nextErrors.expiresAt) expiryRef.current?.focus();
      return;
    }
    if (!templateId) return;

    setLoading(true);
    try {
      const result = await post<{ agreement: AgreementListItem }>('/agreements', {
        templateId,
        title: title.trim(),
        brief: brief.trim() || undefined,
        expiresAt: expiresAt ? expiryIso(expiresAt) : undefined,
      });
      // Apply user-confirmed AI suggestions, never silently: each value was
      // individually accepted in the panel above.
      if (acceptedFields.length > 0) {
        try {
          await patch(`/agreements/${result.agreement.id}`, {
            fields: acceptedFields.map((f) => ({
              code: f.code,
              value: f.value,
              provenance: 'AI_SUGGESTED_CONFIRMED' as const,
            })),
          });
        } catch (patchErr) {
          toast.error(
            `Agreement created, but applying the accepted fields failed: ${
              patchErr instanceof ApiError ? patchErr.message : 'please edit the draft manually.'
            }`,
          );
        }
      }
      toast.success(`Agreement ${result.agreement.publicId} created.`);
      router.push(`/agreements/${result.agreement.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        const serverFieldErrors = err.fieldErrors;
        if (Object.keys(serverFieldErrors).length > 0) {
          setFieldErrors(serverFieldErrors);
          if (serverFieldErrors.title) titleRef.current?.focus();
          else if (serverFieldErrors.expiresAt) expiryRef.current?.focus();
        } else {
          setError(
            err.code === 'VALIDATION_FAILED'
              ? 'Some details need attention. Check the form and try again.'
              : err.message,
          );
        }
      } else {
        setError('Something went wrong. Please try again.');
      }
      setLoading(false);
    }
  }

  const stepOneVisible = mobileStep === 1 ? '' : 'hidden md:block';
  const stepTwoVisible = mobileStep === 2 ? '' : 'hidden md:block';

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 pb-24 md:pb-0">
      <PageHeader
        title="New agreement"
        description="Choose a template, then name your agreement. You can edit the content before review."
        breadcrumb={
          <Link href="/agreements" className="text-navy hover:underline">
            <span className="inline-flex items-center gap-1">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              My Agreements
            </span>
          </Link>
        }
      />

      <p className="text-caps text-ink-3 md:hidden" aria-live="polite">
        Step {mobileStep} of 2
      </p>

      {/* Step 1: template */}
      <section className={`border-y border-rule bg-sheet p-5 ${stepOneVisible}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-serif text-lg text-ink">
              1. Choose a template
            </h2>
            <p className="mt-0.5 text-sm text-ink-2">
              Templates define sections, signing policy, and approval requirements.
            </p>
          </div>
          {categoriesQuery.data ? (
            <Select
              aria-label="Filter by category"
              value={category}
              onChange={(e) => onCategoryChange(e.target.value)}
              className="w-auto"
            >
              <option value="">All categories</option>
              {categoriesQuery.data.categories.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label} ({c.template_count})
                </option>
              ))}
            </Select>
          ) : null}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {templatesQuery.isPending ? (
            showTemplatesPending ? (
              <>
                <CardSkeleton rows={2} />
                <CardSkeleton rows={2} />
              </>
            ) : (
              <div className="sm:col-span-2 min-h-[10rem]" aria-busy="true" aria-live="polite"><LoadingStatus /></div>
            )
          ) : templatesQuery.isError ? (
            <div className="sm:col-span-2">
              <ErrorState onRetry={() => templatesQuery.refetch()} />
            </div>
          ) : (
            templatesQuery.data?.templates.map((t) => {
              const active = t.id === templateId;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => selectTemplate(t)}
                  aria-pressed={active}
                  className={[
                    'rounded-panel border p-4 text-left transition-colors',
                    active
                      ? 'border-navy bg-navy-tint/50 ring-1 ring-navy/30'
                      : 'border-rule bg-sheet hover:border-rule-strong hover:bg-paper',
                  ].join(' ')}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-semibold text-ink">{t.name}</span>
                    <Badge tone={active ? 'brand' : 'neutral'}>{t.category_code}</Badge>
                  </div>
                  {t.description ? (
                    <p className="mt-1.5 line-clamp-2 text-sm text-ink-2">{t.description}</p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-2">
                    <span className="inline-flex items-center gap-1">
                      <FileSignature className="h-3.5 w-3.5" aria-hidden />
                      {t.signing_policy === 'SEQUENTIAL' ? 'Sequential signing' : 'Parallel signing'}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Users className="h-3.5 w-3.5" aria-hidden />
                      {t.required_approvals} approval{t.required_approvals === 1 ? '' : 's'} required
                    </span>
                    <span>v{t.template_version}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>
        {!templatesQuery.isPending && templatesQuery.data?.templates.length === 0 ? (
          <p className="mt-4 text-sm text-ink-2">No templates in this category.</p>
        ) : null}

        {fieldErrors.templateId ? (
          <p className="mt-3 text-sm text-danger" role="alert">
            {fieldErrors.templateId}
          </p>
        ) : null}

        {/* Data-driven preview of what this template asks for */}
        {templateId && selectedTemplate ? (
          <div className="mt-5 border-t border-rule pt-4">
            <TemplateSummary templateId={templateId} />
          </div>
        ) : null}
      </section>

      <div className={stepTwoVisible}>
        {/* AI assistant (optional, unnumbered), describe → extract → confirm */}
        <AssistantPanel
          mode="create"
          templateId={templateId}
          onAcceptedChange={setAcceptedFields}
        />

        {/* Step 2: details */}
        <section className="mt-6 border-y border-rule bg-sheet p-5 md:mt-0">
        <h2 className="font-serif text-lg text-ink">2. Agreement details</h2>
        <p className="mt-0.5 text-sm text-ink-2">
          Only the basics now. Parties and content are edited on the next screen.
        </p>

        <form id="new-agreement-form" onSubmit={onCreate} className="mt-4 flex flex-col gap-4" noValidate>
          <Input
            ref={titleRef}
            label="Title"
            required
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="e.g. Mutual NDA with Acme Corp"
            error={fieldErrors.title}
            disabled={!templateId}
          />
          <Textarea
            label="Brief (optional)"
            value={brief}
            onChange={(e) => {
              setBrief(e.target.value);
              clearFieldError('brief');
            }}
            placeholder="Plain-language description of the intention. Consumed by AI drafting assistance in a later stage."
            error={fieldErrors.brief}
            disabled={!templateId}
            rows={3}
          />
          <Input
            ref={expiryRef}
            label="When should this agreement expire? (optional)"
            type="date"
            value={expiresAt}
            onChange={(e) => onExpiryChange(e.target.value)}
            error={fieldErrors.expiresAt}
            hint={
              expiresAt && !isPastExpiry(expiresAt)
                ? `Expires on ${formatDateLong(`${expiresAt}T00:00:00Z`)}. After that day, the agreement moves to expired.`
                : 'Choose the last day this agreement should be active. After that day, it moves to expired.'
            }
            disabled={!templateId}
            className="sm:w-64"
          />

          {error ? (
            <div
              className="rounded-control border border-danger-rule bg-danger-tint px-3 py-2.5 text-sm text-danger"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          <div className="hidden items-center justify-between border-t border-rule pt-4 md:flex">
            <p className="text-xs text-ink-3">
              {templateId
                ? selectedTemplate
                  ? `Creating from “${selectedTemplate.name}”.`
                  : ''
                : 'Select a template to continue.'}
            </p>
            <Button
              type="submit"
              disabled={!templateId || title.trim().length === 0}
              loading={loading}
              loadingLabel="Creating…"
              icon={<ArrowRight className="h-4 w-4" />}
            >
              Create agreement
            </Button>
          </div>
        </form>
      </section>
      </div>

      {/* Mobile sticky actions (<768px), thumb zone */}
      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-rule bg-sheet px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] md:hidden">
        {mobileStep === 1 ? (
          <Button
            type="button"
            className="w-full"
            disabled={!templateId}
            icon={<ArrowRight className="h-4 w-4" />}
            onClick={() => {
              if (!templateId) {
                setFieldErrors((p) => ({ ...p, templateId: 'Choose a template to continue.' }));
                return;
              }
              setMobileStep(2);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            Continue
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              className="min-w-[5.5rem]"
              onClick={() => {
                setMobileStep(1);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            >
              Back
            </Button>
            <Button
              type="submit"
              form="new-agreement-form"
              className="flex-1"
              disabled={!templateId || title.trim().length === 0}
              loading={loading}
              loadingLabel="Creating…"
              icon={<ArrowRight className="h-4 w-4" />}
            >
              Create agreement
            </Button>
          </div>
        )}
        {mobileStep === 1 && fieldErrors.templateId ? (
          <p className="mt-2 text-sm text-danger" role="alert">
            {fieldErrors.templateId}
          </p>
        ) : null}
      </div>
    </div>
  );
}
