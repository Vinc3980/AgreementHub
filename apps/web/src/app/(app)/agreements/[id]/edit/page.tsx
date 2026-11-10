'use client';

/**
 * Draft editor built on the template engine:
 *  - Fields tab: dynamic form rendered from the template definition
 *    (required markers, guidance, conditional fields appearing live);
 *  - Document tab: composed preview + "Generate document" which replaces
 *    section bodies with the field values (server-side, condition-aware);
 *  - Sections tab: advanced free-form section editing (separate save, so a
 *    later generation is never silently clobbered by stale section text).
 */
import Link from 'next/link';
import { use, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Eye,
  EyeOff,
  FileText,
  RefreshCw,
  Save,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { ErrorState, ListSkeleton } from '@/components/ui/states';
import { DynamicFieldForm } from '@/components/template-engine/field-form';
import { DocumentPreview } from '@/components/template-engine/document-preview';
import { AssistantPanel } from '@/components/ai/assistant-panel';
import { useAgreement, useTemplateDefinition } from '@/lib/queries';
import { useDelayedPending } from '@/lib/use-delayed-pending';
import { useToast } from '@/lib/toast';
import { ApiError, patch, post } from '@/lib/api';
import { canEdit, type ActionContext } from '@/lib/action-rules';
import { useSession } from '@/lib/session';
import { findMissingRequired, parseTemplateDefinition } from '@agreementhub/domain/template';
import type { AgreementDetailResponse, SectionRow, TemplateEvaluationResponse } from '@/lib/types';
import { LoadingStatus } from '@/components/ui/states';

interface SectionDraft {
  code: string;
  title: string;
  body: string;
  included: boolean;
}

type Tab = 'fields' | 'document' | 'sections' | 'assistant';

const TAB_LABELS: Record<Tab, string> = {
  fields: 'Fill in fields',
  document: 'Document preview',
  sections: 'Sections (advanced)',
  assistant: 'Agreement Assistant',
};

export default function EditAgreementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const toast = useToast();
  const queryClient = useQueryClient();
  const { user, organizations } = useSession();

  const detailQuery = useAgreement(id);
  const detail = detailQuery.data as AgreementDetailResponse | undefined;
  const templateQuery = useTemplateDefinition(detail?.agreement.templateId ?? undefined);
  const showDetailPending = useDelayedPending(detailQuery.isPending && !detailQuery.data);
  const definition = useMemo(
    () =>
      templateQuery.data ? parseTemplateDefinition(templateQuery.data.template.content_schema) : null,
    [templateQuery.data],
  );

  const [tab, setTab] = useState<Tab>('fields');
  const [title, setTitle] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [sections, setSections] = useState<SectionDraft[]>([]);
  const [sectionsDirty, setSectionsDirty] = useState(false);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [showRequiredErrors, setShowRequiredErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [preview, setPreview] = useState<TemplateEvaluationResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const ctx: ActionContext = useMemo(() => {
    if (!detail || !user) return { orgRole: null, partyRole: null };
    return {
      orgRole: organizations.find((o) => o.id === detail.agreement.orgId)?.role ?? null,
      partyRole:
        detail.parties.find((p) => p.email.toLowerCase() === user.email.toLowerCase())?.role ??
        null,
    };
  }, [detail, user, organizations]);

  // Keep local state in sync with the server copy, but never clobber unsaved
  // edits: re-initialize only when the server's updatedAt actually changes
  // (own saves, generation, or another participant's edit).
  const syncedUpdatedAt = useRef<string | null>(null);
  useEffect(() => {
    if (!detail || syncedUpdatedAt.current === detail.agreement.updatedAt) return;
    syncedUpdatedAt.current = detail.agreement.updatedAt;
    setTitle(detail.agreement.title);
    setExpiresAt(detail.agreement.expiresAt ? detail.agreement.expiresAt.slice(0, 10) : '');
    setSections(
      detail.sections.map((s: SectionRow) => ({
        code: s.code,
        title: s.title,
        body: s.body,
        included: s.included,
      })),
    );
    setSectionsDirty(false);
    setFieldValues(
      Object.fromEntries(
        detail.fields.map((f) => [
          f.code,
          f.value === null || f.value === undefined ? '' : String(f.value),
        ]),
      ),
    );
  }, [detail]);

  function updateSection(index: number, patchPart: Partial<SectionDraft>) {
    setSectionsDirty(true);
    setSections((prev) => prev.map((s, i) => (i === index ? { ...s, ...patchPart } : s)));
  }

  async function loadPreview() {
    setPreviewLoading(true);
    setError(null);
    try {
      const res = await post<TemplateEvaluationResponse>(`/agreements/${id}/template/preview`, {
        values: fieldValues,
      });
      setPreview(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the preview.');
    } finally {
      setPreviewLoading(false);
    }
  }

  async function onSaveFields() {
    setShowRequiredErrors(true);
    setSaving(true);
    setError(null);
    try {
      const provenanceByCode = new Map(
        (detail?.fields ?? []).map((f) => [f.code, f.provenance]),
      );
      await patch(`/agreements/${id}`, {
        title: title.trim(),
        expiresAt: expiresAt ? `${expiresAt}T23:59:59.999Z` : null,
        fields: Object.entries(fieldValues).map(([code, value]) => ({
          code,
          value,
          provenance: provenanceByCode.get(code) ?? 'USER_PROVIDED',
        })),
      });
      await queryClient.invalidateQueries({ queryKey: ['agreement', id] });
      toast.success('Draft saved. Continue later. Your values are stored on the draft.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the draft.');
    } finally {
      setSaving(false);
    }
  }

  async function onSaveSections() {
    setSaving(true);
    setError(null);
    try {
      await patch(`/agreements/${id}`, { sections });
      await queryClient.invalidateQueries({ queryKey: ['agreement', id] });
      toast.success('Sections saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the sections.');
    } finally {
      setSaving(false);
    }
  }

  async function onGenerate() {
    if (
      sectionsDirty &&
      !window.confirm(
        'Generating replaces manually edited section text with your field values. Continue?',
      )
    ) {
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const res = await post<TemplateEvaluationResponse>(`/agreements/${id}/template/generate`, {
        values: fieldValues,
      });
      setPreview(res);
      await queryClient.invalidateQueries({ queryKey: ['agreement', id] });
      toast.success('Document generated from your field values.');
      setTab('document');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not generate the document.');
    } finally {
      setGenerating(false);
    }
  }

  if (detailQuery.isPending) {
    if (!showDetailPending) return <div className="min-h-[20rem]" aria-busy="true" aria-live="polite"><LoadingStatus /></div>;
    return <ListSkeleton rows={5} />;
  }
  if (detailQuery.isError || !detail) {
    return (
      <ErrorState
        description="We couldn't load this agreement for editing."
        onRetry={() => detailQuery.refetch()}
      />
    );
  }

  const editable = canEdit(detail.agreement.status, ctx);

  if (!editable) {
    return (
      <div className="mx-auto max-w-2xl rounded-panel border border-attention-rule bg-attention-tint px-6 py-10 text-center">
        <h1 className="font-serif text-lg text-ink">This agreement can’t be edited</h1>
        <p className="mt-2 text-sm text-ink-2">
          Editing is limited to the drafting phase (Draft / Negotiation). After signing starts,
          changes must go through a new version.
        </p>
        <div className="mt-5">
          <Link href={`/agreements/${id}`}>
            <Button variant="secondary">Back to agreement</Button>
          </Link>
        </div>
      </div>
    );
  }

  const missingFields = definition ? findMissingRequired(definition, fieldValues) : [];
  const tabs: Tab[] = definition
    ? ['fields', 'document', 'sections', 'assistant']
    : ['fields', 'sections', 'assistant'];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 content-fade-in">
      <PageHeader
        title="Edit draft"
        description={`${detail.agreement.publicId}. Changes are saved to the working copy only.`}
        breadcrumb={
          <Link href={`/agreements/${id}`} className="text-navy hover:underline">
            <span className="inline-flex items-center gap-1">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              Back to agreement
            </span>
          </Link>
        }
        actions={
          <>
            <Link href={`/agreements/${id}`}>
              <Button variant="ghost">Cancel</Button>
            </Link>
            {definition ? (
              <Button
                loading={generating || saving}
                loadingLabel="Generating…"
                icon={<Sparkles className="h-4 w-4" />}
                onClick={onGenerate}
              >
                Generate document
              </Button>
            ) : null}
            <Button loading={saving} icon={<Save className="h-4 w-4" />} onClick={onSaveFields}>
              Save draft
            </Button>
          </>
        }
      />

      {/* Metadata */}
      <section className="border-y border-rule bg-sheet p-5">
        <h2 className="font-serif text-lg text-ink">Details</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Input
              label="Title"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <Input
            label="Expiry date"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            hint="Leave empty for no expiry."
          />
        </div>
      </section>

      {/* Tabs */}
      <div
        className="flex flex-wrap gap-1 rounded-panel border border-rule bg-paper p-1"
        role="tablist"
        aria-label="Editor views"
      >
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={[
              'rounded-control px-3 py-1.5 text-sm font-medium transition-colors',
              tab === t
                ? 'bg-sheet text-ink'
                : 'text-ink-2 hover:text-ink',
            ].join(' ')}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Fields tab, data-driven form */}
      {tab === 'fields' ? (
        <section className="border-y border-rule bg-sheet p-5">
          {definition ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-serif text-lg text-ink">
                  {detail.templateName ?? 'Template fields'}
                </h2>
                {missingFields.length > 0 ? (
                  <Badge tone="warning">
                    {missingFields.length} required remaining
                  </Badge>
                ) : (
                  <Badge tone="success">All required fields complete</Badge>
                )}
              </div>
              {missingFields.length > 0 ? (
                <div
                  className="mt-3 rounded-control border border-attention-rule bg-attention-tint px-3 py-2.5 text-sm text-ink"
                  role="status"
                >
                  Still needed before approvals, signatures, or finalization:{' '}
                  <span className="font-medium">
                    {missingFields.map((m) => m.label).join(', ')}
                  </span>
                  . Conditional fields appear as you answer the questions above them.
                </div>
              ) : null}
              <div className="mt-4">
                <DynamicFieldForm
                  definition={definition}
                  values={fieldValues}
                  showRequiredErrors={showRequiredErrors}
                  onChange={(code, value) =>
                    setFieldValues((prev) => ({ ...prev, [code]: value }))
                  }
                />
              </div>
            </>
          ) : (
            <p className="text-sm text-ink-2">
              This agreement has no template definition to drive a form. Edit its sections in the
              Sections tab.
            </p>
          )}
        </section>
      ) : null}

      {/* Document tab, composed preview */}
      {tab === 'document' && definition ? (
        <section className="border-y border-rule bg-sheet p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-serif text-lg text-ink">Document preview</h2>
              <p className="mt-0.5 text-xs text-ink-2">
                Composed from your field values. Save or generate to keep the result on the draft.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                loading={previewLoading}
                loadingLabel="Refreshing…"
                icon={<RefreshCw className="h-4 w-4" />}
                onClick={loadPreview}
              >
                Refresh preview
              </Button>
              <Button
                loading={generating}
                loadingLabel="Generating…"
                icon={<Sparkles className="h-4 w-4" />}
                onClick={onGenerate}
              >
                Generate document
              </Button>
            </div>
          </div>
          {previewLoading && !preview ? (
            <p className="mt-6 text-sm text-ink-2">Composing preview…</p>
          ) : preview ? (
            <div className="mt-4">
              {preview.missingRequired.length > 0 ? (
                <div
                  className="mb-4 rounded-control border border-attention-rule bg-attention-tint px-3 py-2.5 text-sm text-ink"
                  role="status"
                >
                  {preview.missingRequired.length} required field
                  {preview.missingRequired.length === 1 ? ' is' : 's are'} still blank and shown
                  as gaps below.
                </div>
              ) : null}
              <DocumentPreview
                title={title || detail.agreement.title}
                publicId={detail.agreement.publicId}
                sections={preview.sections}
              />
            </div>
          ) : (
            <p className="mt-6 text-sm text-ink-2">Press “Refresh preview” to compose the document.</p>
          )}
        </section>
      ) : null}

      {/* Sections tab, advanced free-form editing */}
      {tab === 'sections' ? (
        <section className="border-y border-rule bg-sheet p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-serif text-lg text-ink">Sections</h2>
              <p className="mt-0.5 text-xs text-ink-2">
                Advanced: edit section text directly. “Generate document” overwrites these bodies
                with your field values.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge>{sections.filter((s) => s.included).length} included</Badge>
              <Button
                loading={saving}
                loadingLabel="Saving…"
                icon={<Save className="h-4 w-4" />}
                onClick={onSaveSections}
              >
                Save sections
              </Button>
            </div>
          </div>

          <div className="mt-4 space-y-5">
            {sections.map((section, index) => (
              <div
                key={section.code}
                className={`rounded-panel border p-4 ${section.included ? 'border-rule' : 'border-dashed border-rule-strong bg-paper'}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-ink-3">[{section.code}]</span>
                    <input
                      className="rounded-control border border-transparent bg-transparent px-1 text-sm font-semibold text-ink hover:border-rule-strong focus:border-navy focus:outline-none"
                      value={section.title}
                      onChange={(e) => updateSection(index, { title: e.target.value })}
                      aria-label={`Title of section ${section.code}`}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={section.included ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                    onClick={() => updateSection(index, { included: !section.included })}
                  >
                    {section.included ? 'Included' : 'Excluded'}
                  </Button>
                </div>
                <Textarea
                  value={section.body}
                  onChange={(e) => updateSection(index, { body: e.target.value })}
                  rows={Math.min(14, Math.max(4, section.body.split('\n').length + 1))}
                  className="mt-3 font-mono text-[13px]"
                  aria-label={`Body of section ${section.code}`}
                  placeholder="Section text…"
                />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Agreement Assistant tab, extraction + read-only AI features */}
      {tab === 'assistant' ? (
        <AssistantPanel
          mode="edit"
          agreementId={id}
          templateId={detail.agreement.templateId}
          sections={sections.map((s) => ({ code: s.code, title: s.title }))}
          onFocusField={(code) => {
            setTab('fields');
            toast.success(`Opened the form. Look for “${code}”.`);
          }}
        />
      ) : null}

      {error ? (
        <div
          className="rounded-control border border-danger-rule bg-danger-tint px-3 py-2.5 text-sm text-danger"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-5">
        <p className="inline-flex items-center gap-1.5 text-xs text-ink-2">
          <Wrench className="h-3.5 w-3.5" aria-hidden />
          Saving does not change the agreement’s status. Use “Submit for review” on the agreement
          page to advance the workflow.
        </p>
        <div className="flex gap-2">
          {definition ? (
            <Button
              variant="secondary"
              loading={generating || saving}
              loadingLabel="Generating…"
              icon={<FileText className="h-4 w-4" />}
              onClick={onGenerate}
            >
              Generate document
            </Button>
          ) : null}
          <Button loading={saving} loadingLabel="Saving…" icon={<Save className="h-4 w-4" />} onClick={onSaveFields}>
            Save draft
          </Button>
        </div>
      </div>
    </div>
  );
}
