/** Shared React Query hooks for the main domains. */
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { del, get } from './api';
import type {
  AgreementDetailResponse,
  AgreementListResponse,
  AuditEvent,
  CommentListResponse,
  DashboardResponse,
  NotificationListResponse,
  Obligation,
  ObligationOverviewItem,
  ProposalListResponse,
  SessionSummary,
  SignatureListResponse,
  SignatureStatus,
  TemplateCategory,
  TemplateDetailResponse,
  TemplateListItem,
  VersionDiff,
  VersionListItem,
} from './types';

export function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: () => get<DashboardResponse>('/dashboard'),
  });
}

export interface AgreementListParams {
  status?: string;
  category?: string;
  q?: string;
  role?: string;
  dateFrom?: string;
  dateTo?: string;
  cursor?: string | null;
  limit?: number;
}

export function agreementQueryString(p: AgreementListParams): string {
  const params = new URLSearchParams();
  if (p.status) params.set('status', p.status);
  if (p.category) params.set('category', p.category);
  if (p.q) params.set('q', p.q);
  if (p.role) params.set('role', p.role);
  if (p.dateFrom) params.set('dateFrom', p.dateFrom);
  if (p.dateTo) params.set('dateTo', p.dateTo);
  if (p.cursor) params.set('cursor', p.cursor);
  if (p.limit) params.set('limit', String(p.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function useAgreementList(params: AgreementListParams, enabled = true) {
  return useQuery({
    queryKey: ['agreements', params],
    queryFn: () => get<AgreementListResponse>(`/agreements${agreementQueryString(params)}`),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useAgreement(id: string | undefined) {
  return useQuery({
    queryKey: ['agreement', id],
    queryFn: () => get<AgreementDetailResponse>(`/agreements/${id}`),
    enabled: Boolean(id),
  });
}

export function useVersions(id: string | undefined) {
  return useQuery({
    queryKey: ['agreement', id, 'versions'],
    queryFn: () => get<{ versions: VersionListItem[] }>(`/agreements/${id}/versions`),
    enabled: Boolean(id),
  });
}

export function useVersionDiff(versionId: string | undefined, otherVersionId: string | undefined) {
  return useQuery({
    queryKey: ['version-diff', versionId, otherVersionId],
    queryFn: () =>
      get<{ diff: VersionDiff }>(`/versions/${versionId}/diff/${otherVersionId}`),
    enabled: Boolean(versionId && otherVersionId),
  });
}

/** Section comments attached to an agreement (negotiation/review). */
export function useComments(id: string | undefined) {
  return useQuery({
    queryKey: ['agreement', id, 'comments'],
    queryFn: () => get<CommentListResponse>(`/comments?agreementId=${id}`),
    enabled: Boolean(id),
  });
}

/** Change suggestions (propose → accept/reject) for an agreement. */
export function useProposals(id: string | undefined) {
  return useQuery({
    queryKey: ['agreement', id, 'proposals'],
    queryFn: () => get<ProposalListResponse>(`/agreements/${id}/proposals`),
    enabled: Boolean(id),
  });
}

export function useSignatures(id: string | undefined) {
  return useQuery({
    queryKey: ['agreement', id, 'signatures'],
    queryFn: () => get<SignatureListResponse>(`/agreements/${id}/signatures`),
    enabled: Boolean(id),
  });
}

export function useSignatureStatus(id: string | undefined) {
  return useQuery({
    queryKey: ['agreement', id, 'signature-status'],
    queryFn: () => get<SignatureStatus>(`/agreements/${id}/signature-status`),
    enabled: Boolean(id),
  });
}

export function useAudit(id: string | undefined) {
  return useQuery({
    queryKey: ['agreement', id, 'audit'],
    queryFn: () =>
      get<{ events: AuditEvent[]; chainVerified?: boolean; disclaimer?: string }>(
        `/agreements/${id}/audit`,
      ),
    enabled: Boolean(id),
  });
}

export function useObligations(agreementId: string | undefined) {
  return useQuery({
    queryKey: ['agreement', agreementId, 'obligations'],
    queryFn: () => get<{ obligations: Obligation[] }>(`/agreements/${agreementId}/obligations`),
    enabled: Boolean(agreementId),
  });
}

export function useObligationsOverview(
  params: { status?: string; assigned?: string; agreementId?: string; dueFrom?: string; dueTo?: string } = {},
  enabled = true,
) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.assigned) qs.set('assigned', params.assigned);
  if (params.agreementId) qs.set('agreementId', params.agreementId);
  if (params.dueFrom) qs.set('dueFrom', params.dueFrom);
  if (params.dueTo) qs.set('dueTo', params.dueTo);
  const suffix = qs.toString() ? `?${qs}` : '';
  return useQuery({
    queryKey: ['obligations', 'overview', params],
    queryFn: () => get<{ obligations: ObligationOverviewItem[]; summary: { total: number; upcoming: number; overdue: number; recentlyCompleted: number; assignedToMe: number; assignedToOthers: number; needsReview: number } }>(`/obligations${suffix}`),
    enabled,
  });
}

export function useNotifications(unreadOnly: boolean) {
  return useQuery({
    queryKey: ['notifications', 'list', unreadOnly],
    queryFn: () =>
      get<NotificationListResponse>(
        `/notifications?limit=100${unreadOnly ? '&unread=true' : ''}`,
      ),
  });
}

export function useTemplates(category?: string) {
  return useQuery({
    queryKey: ['templates', category ?? 'all'],
    queryFn: () =>
      get<{ templates: TemplateListItem[] }>(`/templates${category ? `?category=${category}` : ''}`),
  });
}

export function useTemplateCategories() {
  return useQuery({
    queryKey: ['template-categories'],
    queryFn: () => get<{ categories: TemplateCategory[] }>('/templates/categories'),
  });
}

/** Full template detail including the engine definition (content_schema). */
export function useTemplateDefinition(templateId: string | undefined) {
  return useQuery({
    queryKey: ['template', templateId],
    queryFn: () => get<TemplateDetailResponse>(`/templates/${templateId}`),
    enabled: Boolean(templateId),
  });
}

export function useSessions() {
  return useQuery({
    queryKey: ['sessions'],
    queryFn: () => get<{ sessions: SessionSummary[] }>('/auth/sessions'),
  });
}

export function revokeSession(id: string) {
  return del(`/auth/sessions/${id}`);
}
