import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, TestServer } from './helpers.js';

let testServer: TestServer;

before(async () => {
  testServer = await startTestServer();
});

after(async () => {
  await testServer.close();
});

test('Health and Error Consistency Suite', async (t) => {
  await t.test('GET /health returns 200 with database, uptime, and timestamp', async () => {
    const res = await fetch(`${testServer.baseUrl}/health`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.status, 'ONLINE');
    assert.equal(json.database, 'connected');
    assert.equal(typeof json.uptime, 'number');
    assert.ok(json.uptime >= 0);
    assert.ok(typeof json.timestamp === 'string');
    assert.ok(!isNaN(Date.parse(json.timestamp)));
  });

  await t.test('GET /api/v1/health returns 200 with database, uptime, and timestamp', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/health`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.status, 'ONLINE');
    assert.equal(json.database, 'connected');
    assert.equal(typeof json.uptime, 'number');
    assert.ok(json.uptime >= 0);
    assert.ok(typeof json.timestamp === 'string');
    assert.ok(!isNaN(Date.parse(json.timestamp)));
  });

  await t.test('GET /api/v1/nonexistent-route returns 404 JSON error response', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/nonexistent-route`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const json = (await res.json()) as any;
    assert.equal(json.success, false);
    assert.match(json.message, /Cannot GET/);
  });

  await t.test('Malformed JSON payload returns consistent JSON error response', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"invalidJson',
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const json = (await res.json()) as any;
    assert.equal(json.success, false);
    assert.ok(typeof json.message === 'string');
  });
});
