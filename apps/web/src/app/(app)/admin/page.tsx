'use client';

/**
 * Protected platform-administration console (audit Phase 7).
 *
 * The API enforces administrator privileges on every request; this page only
 * hides the UI from non-admins. It manages users, agreement templates and
 * categories, shows platform statistics and system activity, and never edits a
 * published template version in place. New versions are separate rows, and
 * finalized agreements keep their immutable snapshots.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  BookOpen,
  FolderTree,
  LayoutDashboard,
  Plus,
  Shield,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Tabs } from '@/components/ui/tabs';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { EmptyState, ErrorState, ListSkeleton, LoadingStatus, Skeleton, staggerStyle } from '@/components/ui/states';
import { useSession } from '@/lib/session';
import { useDelayedPending } from '@/lib/use-delayed-pending';
import { useToast } from '@/lib/toast';
import { ApiError, get, patch, post } from '@/lib/api';
import { formatDateTime, relativeTime, statusLabel } from '@/lib/format';
import type {
  AdminActivity,
  AdminCategory,
  AdminStats,
  AdminTemplate,
  AdminTemplateVersion,
  AdminUser,
} from '@/lib/types';

type AdminTab = 'overview' | 'users' | 'templates' | 'categories' | 'activity';

const MINIMAL_DEFINITION = JSON.stringify(
  {
    definitionVersion: 1,
    sections: [
      { code: 'terms', title: 'Terms', order: 1, required: true, body: 'Agreement terms.' },
    ],
    fields: [{ code: 'party_name', label: 'Party name', type: 'text', required: true }],
  },
  null,
  2,
);

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function StatCard({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-panel border border-rule bg-sheet px-4 py-3">
      <p className="text-caps text-ink-3">{label}</p>
      <p className="mt-2 font-serif text-2xl tabular-nums text-ink">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-ink-2">{hint}</p> : null}
    </div>
  );
}

function Overview() {
  const query = useQuery({
    queryKey: ['admin-stats'],
    queryFn: () => get<{ stats: AdminStats }>('/admin/stats'),
  });
  const showPending = useDelayedPending(query.isPending && !query.data);
  if (query.isPending) {
    if (!showPending) return <div className="min-h-[12rem]" aria-busy="true" aria-live="polite"><LoadingStatus /></div>;
    return (
      <div className="grid gap-3 sm:grid-cols-3" role="status" aria-live="polite" aria-busy="true" aria-label="Loading">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
        <LoadingStatus />
      </div>
    );
  }
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />;
  const s = query.data.stats;

  return (
    <div className="space-y-5 content-fade-in">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Users" value={s.users} hint={`${s.verifiedUsers} verified`} />
        <StatCard label="Agreements" value={s.agreements} hint={`${s.agreementsByStatus.length} statuses in use`} />
        <StatCard label="Published templates" value={s.publishedTemplates} hint={`${s.draftTemplates} drafts`} />
        <StatCard label="Categories" value={s.categories} />
        <StatCard label="Email queue" value={s.outboxPending} hint={`${s.outboxFailed} failed`} />
        <StatCard label="Unread notifications" value={s.unreadNotifications} />
      </div>

      <section className="border-y border-rule bg-sheet p-5">
        <h2 className="font-serif text-lg text-ink">Agreements by status</h2>
        {s.agreementsByStatus.length === 0 ? (
          <p className="mt-2 text-sm text-ink-2">No agreements yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-rule">
            {s.agreementsByStatus.map((row) => (
              <li key={row.status} className="flex items-center justify-between py-2 text-sm">
                <span className="text-ink">{statusLabel(row.status)}</span>
                <span className="font-medium text-ink-2">{row.count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

function UsersPanel() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['admin-users', q],
    queryFn: () => get<{ users: AdminUser[] }>(`/admin/users?q=${encodeURIComponent(q)}`),
  });
  const showPending = useDelayedPending(query.isPending && !query.data);

  async function updateUser(user: AdminUser, patchBody: Record<string, unknown>, key: string) {
    setBusy(`${user.id}:${key}`);
    try {
      await patch(`/admin/users/${user.id}`, patchBody);
      toast.success('User updated.');
      await queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      await queryClient.invalidateQueries({ queryKey: ['admin-stats'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the user.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-sm">
          <Input
            label="Search users"
            placeholder="Email or name"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {query.isPending ? (
        showPending ? (
          <ListSkeleton rows={4} />
        ) : (
          <div className="min-h-[12rem]" aria-busy="true" aria-live="polite"><LoadingStatus /></div>
        )
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : query.data.users.length === 0 ? (
        <EmptyState title="No users found" description="Try a different search." />
      ) : (
        <div className="content-fade-in"><Table>
          <thead>
            <tr>
              <Th>User</Th>
              <Th>Status</Th>
              <Th>Email</Th>
              <Th>Platform admin</Th>
              <Th>Joined</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {query.data.users.map((user, i) => (
              <Tr key={user.id} className="stagger-item" style={staggerStyle(i)}>
                <Td>
                  <div className="font-medium">{user.displayName}</div>
                  <div className="text-xs text-ink-2">{user.email}</div>
                </Td>
                <Td>
                  <Badge tone={user.status === 'ACTIVE' ? 'success' : 'danger'}>{user.status}</Badge>
                </Td>
                <Td>
                  {user.emailVerifiedAt ? (
                    <Badge tone="success">Verified</Badge>
                  ) : (
                    <Badge tone="warning">Unverified</Badge>
                  )}
                </Td>
                <Td>{user.isPlatformAdmin ? <Badge tone="info">Admin</Badge> : '—'}</Td>
                <Td className="text-xs text-ink-2">{relativeTime(user.createdAt)}</Td>
                <Td>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy === `${user.id}:status`}
                      loadingLabel={user.status === 'ACTIVE' ? 'Suspending…' : 'Reactivating…'}
                      onClick={() =>
                        void updateUser(
                          user,
                          { status: user.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' },
                          'status',
                        )
                      }
                    >
                      {user.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy === `${user.id}:admin`}
                      loadingLabel={user.isPlatformAdmin ? 'Removing…' : 'Granting…'}
                      onClick={() =>
                        void updateUser(user, { isPlatformAdmin: !user.isPlatformAdmin }, 'admin')
                      }
                    >
                      {user.isPlatformAdmin ? 'Remove admin' : 'Make admin'}
                    </Button>
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table></div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

function statusTone(status: string): 'success' | 'warning' | 'neutral' {
  if (status === 'PUBLISHED') return 'success';
  if (status === 'DRAFT') return 'warning';
  return 'neutral';
}

interface TemplateFormState {
  categoryId: string;
  name: string;
  description: string;
  signingPolicy: 'PARALLEL' | 'SEQUENTIAL';
  requiredApprovals: number;
  definition: string;
}

const EMPTY_TEMPLATE_FORM: TemplateFormState = {
  categoryId: '',
  name: '',
  description: '',
  signingPolicy: 'PARALLEL',
  requiredApprovals: 1,
  definition: MINIMAL_DEFINITION,
};

function TemplatesPanel() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<TemplateFormState>(EMPTY_TEMPLATE_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<AdminTemplate | null>(null);
  const [versionFor, setVersionFor] = useState<AdminTemplate | null>(null);
  const [versionDefinition, setVersionDefinition] = useState(MINIMAL_DEFINITION);
  const [versionDescription, setVersionDescription] = useState('');

  const templates = useQuery({
    queryKey: ['admin-templates'],
    queryFn: () => get<{ templates: AdminTemplate[] }>('/admin/templates'),
  });
  const categories = useQuery({
    queryKey: ['admin-categories'],
    queryFn: () => get<{ categories: AdminCategory[] }>('/admin/categories'),
  });
  const showTemplatesPending = useDelayedPending(templates.isPending && !templates.data);

  const historyQuery = useQuery({
    queryKey: ['admin-template-versions', history?.id],
    queryFn: () => get<{ versions: AdminTemplateVersion[] }>(`/admin/templates/${history!.id}/versions`),
    enabled: Boolean(history),
  });

  // Prefill a new version from the selected template's latest definition.
  useEffect(() => {
    if (!versionFor) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await get<{ versions: AdminTemplateVersion[] }>(
          `/admin/templates/${versionFor.id}/versions`,
        );
        if (cancelled) return;
        const latest = res.versions[0];
        setVersionDefinition(
          latest ? JSON.stringify(latest.contentSchema, null, 2) : MINIMAL_DEFINITION,
        );
        setVersionDescription(latest?.description ?? versionFor.description);
      } catch {
        if (!cancelled) {
          setVersionDefinition(MINIMAL_DEFINITION);
          setVersionDescription(versionFor.description);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [versionFor]);

  async function refreshTemplates() {
    await queryClient.invalidateQueries({ queryKey: ['admin-templates'] });
    await queryClient.invalidateQueries({ queryKey: ['admin-stats'] });
  }

  async function createTemplate(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const definition = JSON.parse(form.definition) as unknown;
      await post('/admin/templates', {
        categoryId: form.categoryId,
        name: form.name.trim(),
        description: form.description.trim(),
        definition,
        signingPolicy: form.signingPolicy,
        requiredApprovals: form.requiredApprovals,
      });
      toast.success('Draft template created. Publish it when ready.');
      setCreateOpen(false);
      setForm(EMPTY_TEMPLATE_FORM);
      await refreshTemplates();
    } catch (err) {
      if (err instanceof SyntaxError) setFormError('The definition is not valid JSON.');
      else setFormError(err instanceof ApiError ? err.message : 'Could not create the template.');
    } finally {
      setSaving(false);
    }
  }

  async function publish(template: AdminTemplate) {
    try {
      await post(`/admin/templates/${template.id}/publish`);
      toast.success(`Published “${template.name}” v${template.version}.`);
      await refreshTemplates();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not publish the template.');
    }
  }

  async function retire(template: AdminTemplate) {
    try {
      await post(`/admin/templates/${template.id}/retire`);
      toast.success(`Retired “${template.name}” v${template.version}.`);
      await refreshTemplates();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not retire the template.');
    }
  }

  async function createVersion(e: FormEvent) {
    e.preventDefault();
    if (!versionFor) return;
    setSaving(true);
    setFormError(null);
    try {
      const definition = JSON.parse(versionDefinition) as unknown;
      await post(`/admin/templates/${versionFor.id}/versions`, {
        definition,
        description: versionDescription.trim() || undefined,
      });
      toast.success('New draft version created.');
      setVersionFor(null);
      await refreshTemplates();
    } catch (err) {
      if (err instanceof SyntaxError) setFormError('The definition is not valid JSON.');
      else setFormError(err instanceof ApiError ? err.message : 'Could not create the version.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-ink-2">
          Published template versions are immutable. To change a template, create a new version and
          publish it. Existing agreements keep their frozen snapshots.
        </p>
        <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>
          New template
        </Button>
      </div>

      {templates.isPending ? (
        showTemplatesPending ? (
          <ListSkeleton rows={4} />
        ) : (
          <div className="min-h-[12rem]" aria-busy="true" aria-live="polite"><LoadingStatus /></div>
        )
      ) : templates.isError ? (
        <ErrorState onRetry={() => templates.refetch()} />
      ) : templates.data.templates.length === 0 ? (
        <EmptyState title="No templates" description="Create the first template." />
      ) : (
        <div className="content-fade-in"><Table>
          <thead>
            <tr>
              <Th>Template</Th>
              <Th>Category</Th>
              <Th>Version</Th>
              <Th>Status</Th>
              <Th>Policy</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {templates.data.templates.map((template, i) => (
              <Tr key={template.id} className="stagger-item" style={staggerStyle(i)}>
                <Td>
                  <div className="font-medium">{template.name}</div>
                  <div className="max-w-xs truncate text-xs text-ink-2">
                    {template.description || '—'}
                  </div>
                </Td>
                <Td>{template.categoryLabel}</Td>
                <Td>v{template.version}</Td>
                <Td>
                  <Badge tone={statusTone(template.status)}>{template.status}</Badge>
                </Td>
                <Td className="text-xs text-ink-2">
                  {template.signingPolicy} · {template.requiredApprovals} approval(s)
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1.5">
                    {template.status === 'DRAFT' ? (
                      <Button size="sm" onClick={() => void publish(template)}>
                        Publish
                      </Button>
                    ) : null}
                    {template.status === 'PUBLISHED' ? (
                      <Button size="sm" variant="secondary" onClick={() => void retire(template)}>
                        Retire
                      </Button>
                    ) : null}
                    <Button size="sm" variant="secondary" onClick={() => setHistory(template)}>
                      History
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setFormError(null);
                        setVersionFor(template);
                      }}
                    >
                      New version
                    </Button>
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table></div>
      )}

      {/* Create template */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New template"
        description="Starts as a draft; publish it when the definition is ready."
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" form="create-template-form" loading={saving} loadingLabel="Creating…">
              Create draft
            </Button>
          </>
        }
      >
        <form id="create-template-form" onSubmit={createTemplate} className="space-y-4">
          <Select
            label="Category"
            required
            value={form.categoryId}
            onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
          >
            <option value="">Select a category…</option>
            {(categories.data?.categories ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </Select>
          <Input
            label="Name"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Textarea
            label="Description"
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="Signing policy"
              value={form.signingPolicy}
              onChange={(e) =>
                setForm({ ...form, signingPolicy: e.target.value as 'PARALLEL' | 'SEQUENTIAL' })
              }
            >
              <option value="PARALLEL">Parallel</option>
              <option value="SEQUENTIAL">Sequential</option>
            </Select>
            <Input
              label="Required approvals"
              type="number"
              min={0}
              max={20}
              value={form.requiredApprovals}
              onChange={(e) =>
                setForm({ ...form, requiredApprovals: Number(e.target.value) || 0 })
              }
            />
          </div>
          <Textarea
            label="Template definition (JSON)"
            rows={12}
            className="font-mono text-xs"
            value={form.definition}
            onChange={(e) => setForm({ ...form, definition: e.target.value })}
            hint="Sections and fields, as used by the template engine."
          />
          {formError ? (
            <p className="text-sm text-danger" role="alert">
              {formError}
            </p>
          ) : null}
        </form>
      </Modal>

      {/* New version */}
      <Modal
        open={Boolean(versionFor)}
        onClose={() => setVersionFor(null)}
        title={versionFor ? `New version of “${versionFor.name}”` : 'New version'}
        description="Creates a draft version. The currently published version stays live until you publish."
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setVersionFor(null)}>
              Cancel
            </Button>
            <Button type="submit" form="version-form" loading={saving} loadingLabel="Creating…">
              Create version
            </Button>
          </>
        }
      >
        <form id="version-form" onSubmit={createVersion} className="space-y-4">
          <Textarea
            label="Description"
            rows={2}
            value={versionDescription}
            onChange={(e) => setVersionDescription(e.target.value)}
          />
          <Textarea
            label="Template definition (JSON)"
            rows={14}
            className="font-mono text-xs"
            value={versionDefinition}
            onChange={(e) => setVersionDefinition(e.target.value)}
          />
          {formError ? (
            <p className="text-sm text-danger" role="alert">
              {formError}
            </p>
          ) : null}
        </form>
      </Modal>

      {/* Version history */}
      <Modal
        open={Boolean(history)}
        onClose={() => setHistory(null)}
        title={history ? `Version history: ${history.name}` : 'Version history'}
        size="lg"
      >
        {historyQuery.isPending ? (
          <div role="status" aria-live="polite" aria-busy="true"><ListSkeleton rows={3} /></div>
        ) : historyQuery.isError ? (
          <ErrorState onRetry={() => historyQuery.refetch()} />
        ) : (
          <ul className="divide-y divide-rule content-fade-in">
            {historyQuery.data.versions.map((version, i) => (
              <li key={version.id} className="stagger-item flex flex-wrap items-center justify-between gap-2 py-3" style={staggerStyle(i)}>
                <div>
                  <p className="text-sm font-medium text-ink">Version {version.version}</p>
                  <p className="text-xs text-ink-2">Created {formatDateTime(version.createdAt)}</p>
                </div>
                <Badge tone={statusTone(version.status)}>{version.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

function CategoriesPanel() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['admin-categories'],
    queryFn: () => get<{ categories: AdminCategory[] }>('/admin/categories'),
  });
  const showPending = useDelayedPending(query.isPending && !query.data);

  async function create(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await post('/admin/categories', { code: code.trim(), label: label.trim(), sortOrder: 0 });
      toast.success('Category created.');
      setCode('');
      setLabel('');
      await queryClient.invalidateQueries({ queryKey: ['admin-categories'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the category.');
    } finally {
      setSaving(false);
    }
  }

  async function toggle(category: AdminCategory) {
    try {
      await patch(`/admin/categories/${category.id}`, { isEnabled: !category.isEnabled });
      await queryClient.invalidateQueries({ queryKey: ['admin-categories'] });
      await queryClient.invalidateQueries({ queryKey: ['templates'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the category.');
    }
  }

  return (
    <div className="space-y-5">
      <form onSubmit={create} className="rounded-panel border border-rule bg-sheet p-4">
        <h2 className="text-sm font-semibold text-ink">New category</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
          <Input
            label="Code"
            placeholder="consulting"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Input
            label="Label"
            placeholder="Consulting"
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button type="submit" loading={saving} loadingLabel="Adding…" icon={<Plus className="h-4 w-4" />}>
            Add
          </Button>
        </div>
        {error ? (
          <p className="mt-2 text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </form>

      {query.isPending ? (
        showPending ? (
          <ListSkeleton rows={3} />
        ) : (
          <div className="min-h-[10rem]" aria-busy="true" aria-live="polite"><LoadingStatus /></div>
        )
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <div className="content-fade-in"><Table>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Label</Th>
              <Th>Templates</Th>
              <Th>Enabled</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {query.data.categories.map((category, i) => (
              <Tr key={category.id} className="stagger-item" style={staggerStyle(i)}>
                <Td className="font-mono text-xs">{category.code}</Td>
                <Td>{category.label}</Td>
                <Td>{category.templateCount ?? 0}</Td>
                <Td>
                  <Badge tone={category.isEnabled ? 'success' : 'neutral'}>
                    {category.isEnabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                </Td>
                <Td>
                  <Button size="sm" variant="secondary" onClick={() => void toggle(category)}>
                    {category.isEnabled ? 'Disable' : 'Enable'}
                  </Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table></div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Activity                                                            */
/* ------------------------------------------------------------------ */

function ActivityPanel() {
  const query = useQuery({
    queryKey: ['admin-activity'],
    queryFn: () => get<AdminActivity>('/admin/activity?limit=80'),
  });
  const showPending = useDelayedPending(query.isPending && !query.data);
  if (query.isPending) {
    if (!showPending) return <div className="min-h-[12rem]" aria-busy="true" aria-live="polite"><LoadingStatus /></div>;
    return <ListSkeleton rows={6} />;
  }
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />;

  return (
    <div className="grid gap-5 lg:grid-cols-2 content-fade-in">
      <section className="rounded-none border border-rule bg-sheet">
        <h2 className="border-b border-rule px-4 py-3 text-sm font-semibold text-ink">
          Administrator actions
        </h2>
        <ul className="divide-y divide-rule">
          {query.data.adminActions.map((action, i) => (
            <li key={action.id} className="stagger-item px-4 py-3 text-sm" style={staggerStyle(i)}>
              <p className="text-ink">
                <span className="font-medium">{action.actorLabel}</span>{' '}
                <span className="text-ink-2">{action.action.toLowerCase().replace(/_/g, ' ')}</span>
                {action.targetType ? (
                  <span className="text-ink-2"> · {action.targetType}</span>
                ) : null}
              </p>
              <p className="text-xs text-ink-2">{formatDateTime(action.createdAt)}</p>
            </li>
          ))}
          {query.data.adminActions.length === 0 ? (
            <li className="px-4 py-6">
              <EmptyState title="No admin actions" description="Actions appear here as they happen." />
            </li>
          ) : null}
        </ul>
      </section>

      <section className="rounded-none border border-rule bg-sheet">
        <h2 className="border-b border-rule px-4 py-3 text-sm font-semibold text-ink">
          System activity
        </h2>
        <ul className="divide-y divide-rule">
          {query.data.systemActivity.map((event, index) => (
            <li key={`${event.occurredAt}-${index}`} className="stagger-item px-4 py-3 text-sm" style={staggerStyle(index)}>
              <p className="text-ink">
                <span className="font-medium">{event.eventType.replace(/_/g, ' ')}</span>
                {event.publicId ? (
                  <span className="text-ink-2"> · {event.publicId}</span>
                ) : null}
              </p>
              <p className="text-xs text-ink-2">
                {event.actorLabel || event.actorType} · {formatDateTime(event.occurredAt)}
              </p>
            </li>
          ))}
          {query.data.systemActivity.length === 0 ? (
            <li className="px-4 py-6">
              <EmptyState title="No activity yet" />
            </li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function AdminPage() {
  const { user } = useSession();
  const [tab, setTab] = useState<AdminTab>('overview');

  if (!user) return null;

  if (!user.isPlatformAdmin) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center rounded-panel border border-danger-rule bg-danger-tint px-6 py-12 text-center">
        <ShieldAlert className="h-8 w-8 text-danger" aria-hidden />
        <h1 className="mt-3 text-lg font-semibold text-danger">Administrator access required</h1>
        <p className="mt-1.5 text-sm text-ink-2">
          Your account does not have platform-administrator privileges. This page and the
          underlying API are restricted to administrators.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Administration"
        description="Platform users, agreement templates, categories, statistics and activity."
      />

      <Tabs<AdminTab>
        ariaLabel="Administration sections"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'overview', label: <><LayoutDashboard className="h-4 w-4" /> Overview</> },
          { value: 'users', label: <><Users className="h-4 w-4" /> Users</> },
          { value: 'templates', label: <><BookOpen className="h-4 w-4" /> Templates</> },
          { value: 'categories', label: <><FolderTree className="h-4 w-4" /> Categories</> },
          { value: 'activity', label: <><Activity className="h-4 w-4" /> Activity</> },
        ]}
      />

      {tab === 'overview' ? <Overview /> : null}
      {tab === 'users' ? <UsersPanel /> : null}
      {tab === 'templates' ? <TemplatesPanel /> : null}
      {tab === 'categories' ? <CategoriesPanel /> : null}
      {tab === 'activity' ? <ActivityPanel /> : null}

      <p className="flex items-center gap-2 text-xs text-ink-2">
        <Shield className="h-3.5 w-3.5" aria-hidden />
        Administrator actions are recorded in an append-only audit trail.
      </p>
    </div>
  );
}
