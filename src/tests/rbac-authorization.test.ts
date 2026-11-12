import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { startTestServer, TestServer, studentToken, facultyToken, facultyToken2, adminToken } from './helpers.js';
import { assertSessionOwnership } from '../controllers/session.controller.js';

let testServer: TestServer;

before(async () => {
  testServer = await startTestServer();
});

after(async () => {
  await testServer.close();
});

test('RBAC Authorization: assertSessionOwnership helper function', () => {
  // 1. Admin should have universal access
  assert.doesNotThrow(() => {
    assertSessionOwnership({ id: 'admin-1', role: Role.ADMIN }, 'any-faculty-id');
  });

  // 2. Faculty should have access to their own session
  assert.doesNotThrow(() => {
    assertSessionOwnership({ id: 'faculty-1', role: Role.FACULTY }, 'faculty-1');
  });

  // 3. Faculty cannot manage another faculty's session -> 403
  assert.throws(
    () => {
      assertSessionOwnership({ id: 'faculty-1', role: Role.FACULTY }, 'faculty-2');
    },
    (err: any) => {
      assert.equal(err.statusCode, 403);
      assert.match(err.message, /Forbidden/);
      return true;
    }
  );

  // 4. Student role is strictly denied -> 403
  assert.throws(
    () => {
      assertSessionOwnership({ id: 'student-1', role: Role.STUDENT }, 'faculty-1');
    },
    (err: any) => {
      assert.equal(err.statusCode, 403);
      assert.match(err.message, /Forbidden/);
      return true;
    }
  );

  // 5. Unauthenticated user -> 401
  assert.throws(
    () => {
      assertSessionOwnership(undefined, 'faculty-1');
    },
    (err: any) => {
      assert.equal(err.statusCode, 401);
      return true;
    }
  );
});

test('RBAC Authorization: Student tokens are rejected from privileged endpoints with 403', async (t) => {
  const headers = {
    Authorization: `Bearer ${studentToken}`,
    'Content-Type': 'application/json',
  };

  await t.test('Student cannot access GET /api/v1/users (403)', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/users`, { headers });
    assert.equal(res.status, 403);
  });

  await t.test('Student cannot access GET /api/v1/sections/:id (403)', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/sections/test-sec-id`, { headers });
    assert.equal(res.status, 403);
  });

  await t.test('Student cannot access GET /api/v1/enrollments/section/:sectionId (403)', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/enrollments/section/test-sec-id`, { headers });
    assert.equal(res.status, 403);
  });

  await t.test('Student cannot access GET /api/v1/sessions (403)', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/sessions`, { headers });
    assert.equal(res.status, 403);
  });

  await t.test('Student cannot call POST /api/v1/sessions/start (403)', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/sessions/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sectionId: 'test-sec-id' }),
    });
    assert.equal(res.status, 403);
  });

  await t.test('Student cannot call POST /api/v1/sessions/:id/close (403)', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/sessions/test-sess-id/close`, {
      method: 'POST',
      headers,
    });
    assert.equal(res.status, 403);
  });

  await t.test('Student cannot call PATCH /api/v1/sessions/:id/override (403)', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/sessions/test-sess-id/override`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ studentId: 'student-id', status: 'PRESENT', reason: 'Self-override attempt' }),
    });
    assert.equal(res.status, 403);
  });

  await t.test('Student cannot call PATCH /api/v1/sessions/:id/thresholds (403)', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/sessions/test-sess-id/thresholds`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ lateThresholdMins: 10, cutThresholdMins: 30 }),
    });
    assert.equal(res.status, 403);
  });

  await t.test('Student cannot start enrollment mode (403)', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/hardware/enrollment/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ terminalId: 'TERM-01' }),
    });
    assert.equal(res.status, 403);
  });

  await t.test('Student cannot export session reports (403)', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/sessions/test-sess-id/export/pdf`, { headers });
    assert.equal(res.status, 403);
  });
});
