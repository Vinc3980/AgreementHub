/**
 * /dashboard route: aggregate counts, pending actions, recent activity.
 *
 * One endpoint so the dashboard renders without N parallel requests.
 * Visibility matches GET /agreements (org membership + party links); a user
 * only ever sees activity for agreements they can access.
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '@agreementhub/domain';
import { authenticate } from '../plugins/auth.js';
import { many, one } from '../db.js';
import type { ActorContext } from '../services/context.js';

/** Shared visibility predicate, same rules as the agreement list. */
const VISIBILITY = `(
  EXISTS (SELECT 1 FROM organization_members m
          WHERE m.org_id = a.org_id AND m.user_id = $1 AND m.status = 'ACTIVE'
            AND (m.role <> 'MEMBER'
                 OR EXISTS (SELECT 1 FROM agreement_parties p
                            WHERE p.agreement_id = a.id AND p.user_id = $1)))
  OR EXISTS (SELECT 1 FROM agreement_parties p
             WHERE p.agreement_id = a.id AND p.user_id = $1)
)`;

export function registerDashboardRoutes(app: FastifyInstance): void {
  const { ahDb: db } = app;

  app.get('/dashboard', { preHandler: authenticate }, async (request) => {
    const actor = request.actor as ActorContext | undefined;
    if (!actor) throw AppError.unauthorized();
    const userId = actor.userId;

    /* ------------------------------ counts ----------------------------- */
    const counts = await one<{
      total: number;
      drafts: number;
      active: number;
      expiring: number;
      expired: number;
      awaiting_signatures: number;
      closed: number;
    }>(
      db,
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE a.status = 'DRAFT')::int AS drafts,
              COUNT(*) FILTER (WHERE a.status = 'ACTIVE')::int AS active,
              COUNT(*) FILTER (WHERE a.status = 'EXPIRED')::int AS expired,
              COUNT(*) FILTER (WHERE a.status = 'AWAITING_SIGNATURES')::int AS awaiting_signatures,
              COUNT(*) FILTER (WHERE a.status IN ('CANCELLED','TERMINATED','REJECTED'))::int AS closed,
              COUNT(*) FILTER (
                WHERE a.status = 'EXPIRING'
                   OR (a.status = 'ACTIVE' AND a.expires_at IS NOT NULL
                       AND a.expires_at <= now() + interval '30 days')
              )::int AS expiring
       FROM agreements a
       WHERE a.deleted_at IS NULL AND ${VISIBILITY}`,
      [userId],
    );

    /* -------------------------- pending actions ------------------------ */
    // What *this* user must do next: sign, approve, or review/decide.
    const pendingActions = await many<{
      agreement_id: string;
      public_id: string;
      title: string;
      status: string;
      action: string;
      updated_at: Date;
    }>(
      db,
      `WITH visible AS (
         SELECT a.id, a.org_id, a.public_id, a.title, a.status, a.created_by,
                a.updated_at, a.current_version_id
         FROM agreements a
         WHERE a.deleted_at IS NULL AND ${VISIBILITY}
       ),
       actions AS (
         -- Signatures awaited from me
         SELECT v.id, v.public_id, v.title, v.status, v.updated_at, 'SIGN' AS action
         FROM visible v
         JOIN agreement_parties p ON p.agreement_id = v.id AND p.user_id = $1
         WHERE v.status = 'AWAITING_SIGNATURES'
           AND p.role IN ('OWNER','SIGNER') AND p.status <> 'DECLINED'
           AND NOT EXISTS (
             SELECT 1 FROM signatures s WHERE s.agreement_id = v.id AND s.party_id = p.id)
         UNION
         -- Approval awaited from me
         SELECT v.id, v.public_id, v.title, v.status, v.updated_at, 'APPROVE'
         FROM visible v
         JOIN agreement_parties p ON p.agreement_id = v.id AND p.user_id = $1
         JOIN agreement_versions av ON av.id = v.current_version_id
         WHERE av.status = 'PENDING_APPROVAL'
           AND p.role IN ('OWNER','REVIEWER')
           AND NOT EXISTS (
             SELECT 1 FROM approvals ap WHERE ap.version_id = av.id AND ap.party_id = p.id)
         UNION
         -- Submitted for review and I manage it
         SELECT v.id, v.public_id, v.title, v.status, v.updated_at, 'REVIEW'
         FROM visible v
         WHERE v.status IN ('REVIEW','NEGOTIATION')
           AND (v.created_by = $1
                OR EXISTS (SELECT 1 FROM organization_members m
                           WHERE m.org_id = v.org_id AND m.user_id = $1 AND m.status = 'ACTIVE'
                             AND m.role IN ('OWNER','ADMIN','REVIEWER')))
       )
       SELECT id AS agreement_id, public_id, title, status, action, updated_at
       FROM actions
       ORDER BY updated_at DESC
       LIMIT 10`,
      [userId],
    );

    const awaitingAction = await one<{ n: number }>(
      db,
      `WITH visible AS (
         SELECT a.id, a.org_id, a.public_id, a.title, a.status, a.created_by,
                a.updated_at, a.current_version_id
         FROM agreements a
         WHERE a.deleted_at IS NULL AND ${VISIBILITY}
       ),
       actions AS (
         SELECT v.id
         FROM visible v
         JOIN agreement_parties p ON p.agreement_id = v.id AND p.user_id = $1
         WHERE v.status = 'AWAITING_SIGNATURES'
           AND p.role IN ('OWNER','SIGNER') AND p.status <> 'DECLINED'
           AND NOT EXISTS (
             SELECT 1 FROM signatures s WHERE s.agreement_id = v.id AND s.party_id = p.id)
         UNION
         SELECT v.id
         FROM visible v
         JOIN agreement_parties p ON p.agreement_id = v.id AND p.user_id = $1
         JOIN agreement_versions av ON av.id = v.current_version_id
         WHERE av.status = 'PENDING_APPROVAL'
           AND p.role IN ('OWNER','REVIEWER')
           AND NOT EXISTS (
             SELECT 1 FROM approvals ap WHERE ap.version_id = av.id AND ap.party_id = p.id)
         UNION
         SELECT v.id
         FROM visible v
         WHERE v.status IN ('REVIEW','NEGOTIATION')
           AND (v.created_by = $1
                OR EXISTS (SELECT 1 FROM organization_members m
                           WHERE m.org_id = v.org_id AND m.user_id = $1 AND m.status = 'ACTIVE'
                             AND m.role IN ('OWNER','ADMIN','REVIEWER')))
       )
       SELECT COUNT(*)::int AS n FROM actions`,
      [userId],
    );

    /* -------------------------- recent activity ------------------------ */
    const recentActivity = await many<{
      agreement_id: string;
      public_id: string;
      title: string;
      event_type: string;
      actor_label: string;
      occurred_at: Date;
    }>(
      db,
      `SELECT a.id AS agreement_id, a.public_id, a.title,
              e.event_type, e.actor_label, e.occurred_at
       FROM audit_events e
       JOIN agreements a ON a.id = e.agreement_id
       WHERE a.deleted_at IS NULL AND ${VISIBILITY}
       ORDER BY e.occurred_at DESC, e.seq DESC
       LIMIT 12`,
      [userId],
    );

    return {
      counts: {
        total: counts?.total ?? 0,
        drafts: counts?.drafts ?? 0,
        awaitingAction: awaitingAction?.n ?? 0,
        active: counts?.active ?? 0,
        expiring: counts?.expiring ?? 0,
        expired: counts?.expired ?? 0,
        awaitingSignatures: counts?.awaiting_signatures ?? 0,
        closed: counts?.closed ?? 0,
      },
      pendingActions: pendingActions.map((a) => ({
        agreementId: a.agreement_id,
        publicId: a.public_id,
        title: a.title,
        status: a.status,
        action: a.action,
        updatedAt: a.updated_at.toISOString(),
      })),
      recentActivity: recentActivity.map((e) => ({
        agreementId: e.agreement_id,
        publicId: e.public_id,
        title: e.title,
        eventType: e.event_type,
        actorLabel: e.actor_label,
        occurredAt: e.occurred_at.toISOString(),
      })),
    };
  });
}
