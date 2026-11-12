import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AttendanceStatus, AuthMethod } from '@prisma/client';
import { startTestServer, TestServer, studentToken, studentUser } from './helpers.js';
import prisma from '../config/prisma.js';

let testServer: TestServer;

before(async () => {
  testServer = await startTestServer();
});

after(async () => {
  await testServer.close();
});

test('Student Attendance API: GET /api/v1/students/my-attendance', async (t) => {
  await t.test('Unauthenticated call returns 401 Unauthorized', async () => {
    const res = await fetch(`${testServer.baseUrl}/api/v1/students/my-attendance`);
    assert.equal(res.status, 401);
  });

  await t.test('Authenticated call returns personal attendance profile, KPI metrics, and logs', async () => {
    const originalFindUser = prisma.user.findUnique;
    const originalFindLogs = prisma.attendanceLog.findMany;

    try {
      (prisma.user.findUnique as any) = async ({ where }: any) => {
        if (where.id === studentUser.id) {
          return {
            id: studentUser.id,
            studentId: '2023-0001-CCS',
            firstName: studentUser.firstName,
            lastName: studentUser.lastName,
            email: studentUser.email,
            department: 'College of Computer Studies',
          };
        }
        return null;
      };

      (prisma.attendanceLog.findMany as any) = async ({ where }: any) => {
        if (where.studentId === studentUser.id) {
          return [
            {
              id: 'log-1',
              sessionId: 'sess-1',
              studentId: studentUser.id,
              status: AttendanceStatus.PRESENT,
              authMethod: AuthMethod.RFID_TAP,
              tapTimestamp: new Date('2026-11-12T08:05:00.000Z'),
              createdAt: new Date('2026-11-12T08:05:00.000Z'),
              isManualOverride: false,
              overrideReason: null,
              session: {
                id: 'sess-1',
                section: {
                  sectionCode: 'CS101-BSIT3A',
                  courseName: 'Data Structures and Algorithms',
                  roomNumber: 'LAB-603',
                },
                faculty: {
                  id: 'fac-1',
                  firstName: 'Alan',
                  lastName: 'Turing',
                  email: 'alan@orchestra.edu',
                },
              },
            },
            {
              id: 'log-2',
              sessionId: 'sess-2',
              studentId: studentUser.id,
              status: AttendanceStatus.LATE,
              authMethod: AuthMethod.KEYPAD_OTP,
              tapTimestamp: new Date('2026-11-11T08:20:00.000Z'),
              createdAt: new Date('2026-11-11T08:20:00.000Z'),
              isManualOverride: false,
              overrideReason: null,
              session: {
                id: 'sess-2',
                section: {
                  sectionCode: 'CS102-BSIT3A',
                  courseName: 'Database Systems',
                  roomNumber: 'LAB-604',
                },
                faculty: {
                  id: 'fac-1',
                  firstName: 'Alan',
                  lastName: 'Turing',
                  email: 'alan@orchestra.edu',
                },
              },
            },
            {
              id: 'log-3',
              sessionId: 'sess-3',
              studentId: studentUser.id,
              status: AttendanceStatus.ABSENT,
              authMethod: AuthMethod.AUTO_ABSENT,
              tapTimestamp: null,
              createdAt: new Date('2026-11-10T08:00:00.000Z'),
              isManualOverride: false,
              overrideReason: null,
              session: {
                id: 'sess-3',
                section: {
                  sectionCode: 'CS101-BSIT3A',
                  courseName: 'Data Structures and Algorithms',
                  roomNumber: 'LAB-603',
                },
                faculty: {
                  id: 'fac-1',
                  firstName: 'Alan',
                  lastName: 'Turing',
                  email: 'alan@orchestra.edu',
                },
              },
            },
          ];
        }
        return [];
      };

      const res = await fetch(`${testServer.baseUrl}/api/v1/students/my-attendance`, {
        headers: {
          Authorization: `Bearer ${studentToken}`,
        },
      });

      assert.equal(res.status, 200);
      const json = (await res.json()) as any;
      assert.equal(json.success, true);
      assert.ok(json.data);

      // Verify student identity block
      assert.equal(json.data.student.studentId, '2023-0001-CCS');
      assert.equal(json.data.student.name, `${studentUser.firstName} ${studentUser.lastName}`);

      // Verify KPI metrics block: 3 total, 1 present, 1 late, 0 excused, 1 absent
      // Attended: 2 / 3 = 66.7%
      assert.equal(json.data.kpi.total, 3);
      assert.equal(json.data.kpi.present, 1);
      assert.equal(json.data.kpi.late, 1);
      assert.equal(json.data.kpi.excused, 0);
      assert.equal(json.data.kpi.absent, 1);
      assert.equal(json.data.kpi.rate, 66.7);

      // Verify logs array
      assert.equal(json.data.logs.length, 3);
      assert.equal(json.data.logs[0].session.courseCode, 'CS101-BSIT3A');
      assert.equal(json.data.logs[0].status, 'PRESENT');
      assert.equal(json.data.logs[0].authMethod, 'RFID_TAP');
    } finally {
      (prisma.user.findUnique as any) = originalFindUser;
      (prisma.attendanceLog.findMany as any) = originalFindLogs;
    }
  });
});
