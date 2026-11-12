import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, TestServer, adminToken, facultyToken, studentToken } from './helpers.js';
import { env } from '../config/env.js';

let testServer: TestServer;

before(async () => {
  testServer = await startTestServer();
});

after(async () => {
  await testServer.close();
});

test('Route Protection: Unauthenticated requests are rejected with 401', async (t) => {
  await t.test('GET /api/v1/users without auth returns 401', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/users`);
    assert.equal(res.status, 401);
    const json = (await res.json()) as any;
    assert.equal(json.success, false);
  });

  await t.test('GET /api/v1/users/:id without auth returns 401', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/users/some-id`);
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/v1/sections without auth returns 401', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/sections`);
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/v1/sections/:id without auth returns 401', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/sections/some-section-id`);
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/v1/enrollments/section/:sectionId without auth returns 401', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/enrollments/section/some-sec-id`);
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/v1/sessions without auth returns 401', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/sessions`);
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/v1/sessions/:id/export/pdf without auth returns 401', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/sessions/some-session-id/export/pdf`);
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/v1/sessions/:id/export/csv without auth returns 401', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/sessions/some-session-id/export/csv`);
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/v1/sessions/:id/export/xlsx without auth returns 401', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/sessions/some-session-id/export/xlsx`);
    assert.equal(res.status, 401);
  });

  await t.test('POST /api/v1/hardware/enrollment/start without auth returns 401', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/hardware/enrollment/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId: 'TERM-01' }),
    });
    assert.equal(res.status, 401);
  });

  await t.test('POST /api/v1/hardware/enrollment/stop without auth returns 401', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/hardware/enrollment/stop`, {
      method: 'POST',
    });
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/v1/hardware/last-scanned without auth returns 401', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/hardware/last-scanned`);
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/v1/hardware/enrollment/status without auth returns 401', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/hardware/enrollment/status`);
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/v1/hardware/status/:terminalId without api-key or token returns 401', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/hardware/status/TERM-01`);
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/v1/hardware/status/:terminalId with hardware API key succeeds', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/hardware/status/TERM-01`, {
      headers: { 'x-api-key': env.HARDWARE_API_KEY },
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.success, true);
    assert.ok(Array.isArray(json.authorizedFaculty));
  });

  await t.test('GET /api/v1/hardware/status/:terminalId with user JWT succeeds', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/hardware/status/TERM-01`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.success, true);
  });

  await t.test('POST /api/v1/otp/request without auth returns 401', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: '2023-0001-CCS' }),
    });
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/v1/students/my-attendance without auth returns 401', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/students/my-attendance`);
    assert.equal(res.status, 401);
  });
});
