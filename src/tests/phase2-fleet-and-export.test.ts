import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AttendanceStatus, AuthMethod, Role, SessionStatus } from '@prisma/client';
import { startTestServer, TestServer, adminToken, facultyToken, studentToken, adminUser, facultyUser } from './helpers.js';
import prisma from '../config/prisma.js';
import { env } from '../config/env.js';

let testServer: TestServer;

before(async () => {
  testServer = await startTestServer();
});

after(async () => {
  await testServer.close();
});

test('P5 Telemetry Watchdog: Heartbeat, Fleet Discovery, and Quiet Mode', async (t) => {
  const hardwareHeaders = {
    'Content-Type': 'application/json',
    'x-api-key': env.HARDWARE_API_KEY,
  };

  const adminHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${adminToken}`,
  };

  await t.test('POST /api/v1/hardware/heartbeat records telemetry and computes status', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/hardware/heartbeat`, {
      method: 'POST',
      headers: hardwareHeaders,
      body: JSON.stringify({
        terminalId: 'TERM-FLEET-01',
        rssi: -62,
        freeHeap: 210000,
        uptimeSec: 3600,
        readerStatus: 'MFRC522 OK',
        version: 'v1.0.4-PRO',
      }),
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.success, true);
    assert.equal(json.data.terminalId, 'TERM-FLEET-01');
    assert.equal(json.data.status, 'ONLINE');
    assert.equal(json.data.readerStatus, 'MFRC522 OK');
    assert.equal(json.data.isQuietMode, false);
  });

  await t.test('POST /api/v1/hardware/heartbeat marks weak signal on high attenuation', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/hardware/heartbeat`, {
      method: 'POST',
      headers: hardwareHeaders,
      body: JSON.stringify({
        terminalId: 'TERM-WEAK-01',
        rssi: -86,
        freeHeap: 180000,
        uptimeSec: 400,
      }),
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.success, true);
    assert.equal(json.data.terminalId, 'TERM-WEAK-01');
    assert.equal(json.data.status, 'WEAK_RSSI');
    assert.equal(json.data.readerStatus, 'OK'); // Default fallback
  });

  await t.test('POST /api/v1/hardware/heartbeat handles coerced number strings', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/hardware/heartbeat`, {
      method: 'POST',
      headers: hardwareHeaders,
      body: JSON.stringify({
        terminalId: 'TERM-COERCE-01',
        rssi: '-72',
        freeHeap: '195000',
        uptimeSec: '120',
      }),
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.success, true);
    assert.equal(json.data.rssi, -72);
    assert.equal(json.data.freeHeap, 195000);
    assert.equal(json.data.uptimeSec, 120);
  });

  await t.test('GET /api/v1/hardware/terminals exposes fleet list', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/hardware/terminals`, {
      headers: adminHeaders,
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.success, true);
    assert.ok(Array.isArray(json.data));
    const term = json.data.find((t: any) => t.terminalId === 'TERM-FLEET-01');
    assert.ok(term);
    assert.equal(term.status, 'ONLINE');
  });

  await t.test('GET /api/v1/hardware/terminals works with query token (?token=...) without auth header', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/hardware/terminals?token=${adminToken}`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.success, true);
    assert.ok(Array.isArray(json.data));
  });

  await t.test('POST /api/v1/hardware/quiet-mode toggles audio damping state', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/hardware/quiet-mode`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        terminalId: 'TERM-FLEET-01',
        enabled: true,
      }),
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.success, true);
    assert.equal(json.data.terminalId, 'TERM-FLEET-01');
    assert.equal(json.data.isQuietMode, true);

    // Subsequent heartbeat to TERM-FLEET-01 reflects isQuietMode=true in response
    const hbRes = await fetch(`${testServer.baseUrl}/api/v1/hardware/heartbeat`, {
      method: 'POST',
      headers: hardwareHeaders,
      body: JSON.stringify({
        terminalId: 'TERM-FLEET-01',
        rssi: -60,
        freeHeap: 210000,
        uptimeSec: 3660,
      }),
    });
    const hbJson = (await hbRes.json()) as any;
    assert.equal(hbJson.data.isQuietMode, true);
  });
});

test('P6 1-Click LMS & Institutional Export Endpoints', async (t) => {
  const mockSessionId = 'sess-export-mock-01';
  const mockSectionId = 'sec-export-mock-01';

  const originalFindSession = prisma.session.findUnique;
  const originalFindEnrollments = prisma.enrollment.findMany;

  before(() => {
    (prisma.session.findUnique as any) = async ({ where }: any) => {
      if (where.id === mockSessionId) {
        return {
          id: mockSessionId,
          sectionId: mockSectionId,
          facultyId: facultyUser.id,
          terminalId: 'TERM-TEST-EXP',
          status: SessionStatus.CLOSED,
          startTime: new Date('2026-11-14T08:00:00Z'),
          endTime: new Date('2026-11-14T10:00:00Z'),
          lateThresholdMins: 15,
          cutThresholdMins: 45,
          section: {
            id: mockSectionId,
            sectionCode: 'IT304-CS3A',
            courseName: 'Distributed Embedded Systems',
            roomNumber: 'LAB-304',
          },
          faculty: {
            id: facultyUser.id,
            firstName: facultyUser.firstName,
            lastName: facultyUser.lastName,
            email: facultyUser.email,
          },
          attendanceLogs: [
            {
              id: 'log-1',
              sessionId: mockSessionId,
              studentId: 'student-1',
              status: AttendanceStatus.PRESENT,
              authMethod: AuthMethod.RFID_TAP,
              tapTimestamp: new Date('2026-11-14T08:05:00Z'),
              isManualOverride: false,
              overrideReason: null,
              student: {
                id: 'student-1',
                studentId: '2023-0001-CCS',
                firstName: 'Alice',
                lastName: 'Smith',
                email: 'alice@orchestra.edu',
              },
            },
            {
              id: 'log-2',
              sessionId: mockSessionId,
              studentId: 'student-2',
              status: AttendanceStatus.LATE,
              authMethod: AuthMethod.KEYPAD_OTP,
              tapTimestamp: new Date('2026-11-14T08:22:00Z'),
              isManualOverride: false,
              overrideReason: null,
              student: {
                id: 'student-2',
                studentId: '2023-0002-CCS',
                firstName: 'Bob',
                lastName: 'Jones',
                email: 'bob@orchestra.edu',
              },
            },
          ],
        };
      }
      return null;
    };

    (prisma.enrollment.findMany as any) = async ({ where }: any) => {
      if (where.sectionId === mockSectionId) {
        return [
          {
            id: 'enr-1',
            sectionId: mockSectionId,
            studentId: 'student-1',
            student: {
              id: 'student-1',
              studentId: '2023-0001-CCS',
              firstName: 'Alice',
              lastName: 'Smith',
              email: 'alice@orchestra.edu',
            },
          },
          {
            id: 'enr-2',
            sectionId: mockSectionId,
            studentId: 'student-2',
            student: {
              id: 'student-2',
              studentId: '2023-0002-CCS',
              firstName: 'Bob',
              lastName: 'Jones',
              email: 'bob@orchestra.edu',
            },
          },
          {
            id: 'enr-3',
            sectionId: mockSectionId,
            studentId: 'student-3',
            student: {
              id: 'student-3',
              studentId: '2023-0003-CCS',
              firstName: 'Charlie',
              lastName: 'Brown',
              email: 'charlie@orchestra.edu',
            },
          },
        ];
      }
      return [];
    };
  });

  after(() => {
    prisma.session.findUnique = originalFindSession;
    prisma.enrollment.findMany = originalFindEnrollments;
  });

  await t.test('Unauthenticated calls to export endpoints return 401', async () => {
    const res1 = await fetch(`${testServer.baseUrl}/api/v1/sessions/${mockSessionId}/export/canvas`);
    assert.equal(res1.status, 401);

    const res2 = await fetch(`${testServer.baseUrl}/api/v1/sessions/${mockSessionId}/export/moodle`);
    assert.equal(res2.status, 401);

    const res3 = await fetch(`${testServer.baseUrl}/api/v1/sessions/${mockSessionId}/export/institutional-pdf`);
    assert.equal(res3.status, 401);
  });

  await t.test('Student cannot access LMS or Institutional export endpoints (403)', async () => {
    const studentHeaders = { Authorization: `Bearer ${studentToken}` };

    const res1 = await fetch(`${testServer.baseUrl}/api/v1/sessions/${mockSessionId}/export/canvas`, { headers: studentHeaders });
    assert.equal(res1.status, 403);

    const res2 = await fetch(`${testServer.baseUrl}/api/v1/sessions/${mockSessionId}/export/moodle`, { headers: studentHeaders });
    assert.equal(res2.status, 403);

    const res3 = await fetch(`${testServer.baseUrl}/api/v1/sessions/${mockSessionId}/export/institutional-pdf`, { headers: studentHeaders });
    assert.equal(res3.status, 403);
  });

  await t.test('Faculty owner exports Canvas SIS CSV format (Student ID, Name, Grade score / 100)', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/sessions/${mockSessionId}/export/canvas`, {
      headers: { Authorization: `Bearer ${facultyToken}` },
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/csv/);
    const body = await res.text();
    assert.match(body, /Student ID,Name,Attendance Grade/);
    assert.match(body, /2023-0001-CCS,"Smith, Alice",100/);
    assert.match(body, /2023-0002-CCS,"Jones, Bob",80/);
    assert.match(body, /2023-0003-CCS,"Brown, Charlie",0/);
  });

  await t.test('Faculty owner exports Moodle Attendance CSV format (P, L, E, A notation columns)', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/sessions/${mockSessionId}/export/moodle`, {
      headers: { Authorization: `Bearer ${facultyToken}` },
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/csv/);
    const body = await res.text();
    assert.match(body, /Student ID,Name,Email,Attendance Code,P,L,E,A/);
    assert.match(body, /2023-0001-CCS,"Smith, Alice",alice@orchestra.edu,P,1,0,0,0/);
    assert.match(body, /2023-0002-CCS,"Jones, Bob",bob@orchestra.edu,L,0,1,0,0/);
    assert.match(body, /2023-0003-CCS,"Brown, Charlie",charlie@orchestra.edu,A,0,0,0,1/);
  });

  await t.test('Faculty owner exports Formal Institutional Master PDF with university header & signature block', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/sessions/${mockSessionId}/export/institutional-pdf`, {
      headers: { Authorization: `Bearer ${facultyToken}` },
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/pdf/);
    const buffer = Buffer.from(await res.arrayBuffer());
    assert.ok(buffer.length > 1000);
    // PDF Magic bytes check
    assert.equal(buffer.slice(0, 4).toString(), '%PDF');
  });

  await t.test('Export works via browser query token parameter (?token=...)', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/sessions/${mockSessionId}/export/canvas?token=${facultyToken}`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Student ID,Name,Attendance Grade/);
  });
});
