/**
 * Platform administration (audit Phase 7).
 *
 * Ordinary organization owners are never platform admins. Every admin route
 * enforces the flag server-side and writes an append-only audit event.
 * Published template versions are immutable; changes create new versions.
 */
import { describe, expect, it } from 'vitest';
import {
  createAgreement,
  get,
  patch,
  post,
  registerUser,
  uniqueEmail,
  useTestApp,
} from './helpers.js';

const h = useTestApp();

async function makeAdmin() {
  const admin = await registerUser(h(), uniqueEmail('admin'));
  await h().db.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [admin.userId]);
  return admin;
}

const MINIMAL_DEFINITION = {
  definitionVersion: 1,
  sections: [
    { code: 'terms', title: 'Terms', order: 1, required: true, body: 'Original terms.' },
  ],
  fields: [{ code: 'party_name', label: 'Party name', type: 'text', required: true }],
};

async function firstCategoryId(adminToken: string): Promise<string> {
  const res = await get(h(), '/api/v1/admin/categories', adminToken);
  expect(res.statusCode).toBe(200);
  return res.json().categories[0].id as string;
}

describe('platform administration permissions', () => {
  it('refuses every admin endpoint to ordinary users', async () => {
    const user = await registerUser(h());
    const endpoints: Array<[string, string, unknown]> = [
      ['GET', '/api/v1/admin/stats', undefined],
      ['GET', '/api/v1/admin/users', undefined],
      ['GET', '/api/v1/admin/templates', undefined],
      ['GET', '/api/v1/admin/categories', undefined],
      ['GET', '/api/v1/admin/activity', undefined],
      ['POST', '/api/v1/admin/categories', { code: 'sneaky', label: 'Sneaky' }],
      [
        'POST',
        '/api/v1/admin/templates',
        {
          categoryId: '00000000-0000-4000-8000-000000000000',
          name: 'Sneaky',
          definition: MINIMAL_DEFINITION,
        },
      ],
    ];

    for (const [method, url, body] of endpoints) {
      const res =
        method === 'GET'
          ? await get(h(), url, user.token)
          : await post(h(), url, body, user.token);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }

    // Unauthenticated requests are rejected before the admin check.
    expect((await get(h(), '/api/v1/admin/stats')).statusCode).toBe(401);
  });

  it('shows platform statistics and user search to administrators', async () => {
    const admin = await makeAdmin();
    const other = await registerUser(h());

    const stats = await get(h(), '/api/v1/admin/stats', admin.token);
    expect(stats.statusCode).toBe(200);
    expect(stats.json().stats.users).toBeGreaterThanOrEqual(2);
    expect(stats.json().stats.verifiedUsers).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(stats.json().stats.agreementsByStatus)).toBe(true);

    const search = await get(
      h(),
      `/api/v1/admin/users?q=${encodeURIComponent(other.email)}`,
      admin.token,
    );
    expect(search.statusCode).toBe(200);
    expect(search.json().users).toHaveLength(1);
    expect(search.json().users[0].email).toBe(other.email);
    expect(search.json().users[0].emailVerifiedAt).toBeTruthy();
  });

  it('suspends accounts and revokes their sessions; reactivation restores login', async () => {
    const admin = await makeAdmin();
    const target = await registerUser(h());

    const suspend = await patch(
      h(),
      `/api/v1/admin/users/${target.userId}`,
      { status: 'SUSPENDED' },
      admin.token,
    );
    expect(suspend.statusCode).toBe(200);
    expect(suspend.json().user.status).toBe('SUSPENDED');

    // The existing session is revoked immediately.
    const existing = await get(h(), '/api/v1/users/me', target.token);
    expect(existing.statusCode).toBe(401);

    const login = await post(h(), '/api/v1/auth/login', {
      email: target.email,
      password: 'Password123',
    });
    expect(login.statusCode).toBe(403);

    const reactivate = await patch(
      h(),
      `/api/v1/admin/users/${target.userId}`,
      { status: 'ACTIVE' },
      admin.token,
    );
    expect(reactivate.statusCode).toBe(200);

    const relogin = await post(h(), '/api/v1/auth/login', {
      email: target.email,
      password: 'Password123',
    });
    expect(relogin.statusCode).toBe(200);
  });

  it('protects the last administrator and blocks self-suspension', async () => {
    const admin = await makeAdmin();
    const target = await registerUser(h());

    const selfSuspend = await patch(
      h(),
      `/api/v1/admin/users/${admin.userId}`,
      { status: 'SUSPENDED' },
      admin.token,
    );
    expect(selfSuspend.statusCode).toBe(409);
    expect(selfSuspend.json().code).toBe('SELF_SUSPEND');

    const lastAdmin = await patch(
      h(),
      `/api/v1/admin/users/${admin.userId}`,
      { isPlatformAdmin: false },
      admin.token,
    );
    expect(lastAdmin.statusCode).toBe(409);
    expect(lastAdmin.json().code).toBe('LAST_ADMIN');

    // Promoting a second admin allows the first to step down.
    expect(
      (
        await patch(
          h(),
          `/api/v1/admin/users/${target.userId}`,
          { isPlatformAdmin: true },
          admin.token,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await patch(
          h(),
          `/api/v1/admin/users/${admin.userId}`,
          { isPlatformAdmin: false },
          admin.token,
        )
      ).statusCode,
    ).toBe(200);
  });
});

describe('template and category management', () => {
  it('manages categories and hides disabled ones from the public catalogue', async () => {
    const admin = await makeAdmin();
    const created = await post(
      h(),
      '/api/v1/admin/categories',
      { code: 'audit-cat', label: 'Audit Category', sortOrder: 500 },
      admin.token,
    );
    expect(created.statusCode).toBe(201);
    const categoryId = created.json().category.id as string;

    const duplicate = await post(
      h(),
      '/api/v1/admin/categories',
      { code: 'audit-cat', label: 'Duplicate' },
      admin.token,
    );
    expect(duplicate.statusCode).toBe(409);

    let publicList = await get(h(), '/api/v1/templates/categories');
    expect(
      publicList.json().categories.some((c: { code: string }) => c.code === 'audit-cat'),
    ).toBe(true);

    const disabled = await patch(
      h(),
      `/api/v1/admin/categories/${categoryId}`,
      { isEnabled: false },
      admin.token,
    );
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().category.isEnabled).toBe(false);

    publicList = await get(h(), '/api/v1/templates/categories');
    expect(
      publicList.json().categories.some((c: { code: string }) => c.code === 'audit-cat'),
    ).toBe(false);
  });

  it('publishes new template versions as new rows and never edits published ones', async () => {
    const admin = await makeAdmin();
    const categoryId = await firstCategoryId(admin.token);

    const created = await post(
      h(),
      '/api/v1/admin/templates',
      {
        categoryId,
        name: 'Audit Template',
        description: 'Version one',
        definition: MINIMAL_DEFINITION,
        signingPolicy: 'PARALLEL',
        requiredApprovals: 1,
      },
      admin.token,
    );
    expect(created.statusCode).toBe(201);
    const v1Id = created.json().template.id as string;

    // Drafts can be edited; publishing freezes the row.
    expect(
      (
        await patch(
          h(),
          `/api/v1/admin/templates/${v1Id}`,
          { description: 'Version one (edited)' },
          admin.token,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await post(h(), `/api/v1/admin/templates/${v1Id}/publish`, {}, admin.token)).statusCode,
    ).toBe(200);

    const publishedEdit = await patch(
      h(),
      `/api/v1/admin/templates/${v1Id}`,
      { description: 'Sneaky edit' },
      admin.token,
    );
    expect(publishedEdit.statusCode).toBe(409);
    expect(publishedEdit.json().code).toBe('TEMPLATE_IMMUTABLE');

    // An agreement can be created from v1.
    const user = await registerUser(h());
    const agreement = await createAgreement(h(), user.token, v1Id, 'Pinned to v1');

    // New version is a separate DRAFT row.
    const version = await post(
      h(),
      `/api/v1/admin/templates/${v1Id}/versions`,
      {
        description: 'Version two',
        definition: {
          definitionVersion: 1,
          sections: [
            { code: 'terms', title: 'Terms', order: 1, required: true, body: 'Updated terms.' },
          ],
          fields: [{ code: 'party_name', label: 'Party name', type: 'text', required: true }],
        },
      },
      admin.token,
    );
    expect(version.statusCode).toBe(201);
    const v2Id = version.json().version.id as string;
    expect(version.json().version.versionNumber).toBe(2);

    // Publishing v2 retires v1 but leaves both rows and their definitions.
    expect(
      (await post(h(), `/api/v1/admin/templates/${v2Id}/publish`, {}, admin.token)).statusCode,
    ).toBe(200);

    const history = await get(
      h(),
      `/api/v1/admin/templates/${v1Id}/versions`,
      admin.token,
    );
    expect(history.statusCode).toBe(200);
    expect(history.json().versions).toHaveLength(2);
    expect(history.json().versions[0].version).toBe(2);
    expect(history.json().versions[0].status).toBe('PUBLISHED');
    expect(history.json().versions[1].version).toBe(1);
    expect(history.json().versions[1].status).toBe('RETIRED');
    expect(history.json().versions[1].contentSchema).toEqual(MINIMAL_DEFINITION);

    // The existing agreement keeps the version it was created with.
    const detail = await get(h(), `/api/v1/agreements/${agreement.agreement.id}`, user.token);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().currentVersion.versionNumber).toBe(1);
    expect(detail.json().currentVersion.documentHash).toBe(agreement.initialVersion.documentHash);

    const publicTemplates = await get(h(), '/api/v1/templates');
    expect(
      publicTemplates.json().templates.some((t: { id: string }) => t.id === v1Id),
    ).toBe(false);
    expect(
      publicTemplates.json().templates.some((t: { id: string }) => t.id === v2Id),
    ).toBe(true);

    // Admin actions were audited.
    const activity = await get(h(), '/api/v1/admin/activity', admin.token);
    expect(activity.statusCode).toBe(200);
    const actions = activity.json().adminActions.map((a: { action: string }) => a.action);
    expect(actions).toContain('TEMPLATE_CREATED');
    expect(actions).toContain('TEMPLATE_PUBLISHED');
    expect(actions).toContain('TEMPLATE_VERSION_CREATED');
  });

  it('keeps the platform audit trail append-only', async () => {
    const admin = await makeAdmin();
    await post(
      h(),
      '/api/v1/admin/categories',
      { code: 'audit-append', label: 'Append Only' },
      admin.token,
    );

    await expect(
      h().db.query(`UPDATE platform_audit_events SET action = 'tampered'`),
    ).rejects.toThrow(/append-only/i);
    await expect(h().db.query(`DELETE FROM platform_audit_events`)).rejects.toThrow(
      /append-only/i,
    );
  });
});
