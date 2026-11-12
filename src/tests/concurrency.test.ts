import test from 'node:test';
import assert from 'node:assert/strict';
import { hardwareService } from '../services/hardware.service.js';
import { otpService } from '../services/otp.service.js';
import { sessionService } from '../services/session.service.js';
import prisma from '../config/prisma.js';

test('Concurrency & Check-Then-Act: Prisma P2002 collision handling', async (t) => {
  await t.test('processCardTap returns 409 ALREADY_RECORDED when Prisma throws P2002', async () => {
    // Save original Prisma methods
    const originalFindUnique = prisma.attendanceLog.findUnique;
    const originalCreate = prisma.attendanceLog.create;
    const originalFindSession = prisma.session.findFirst;
    const originalFindUser = prisma.user.findUnique;
    const originalFindEnrollment = prisma.enrollment.findUnique;

    try {
      // Mock active session
      (prisma.session.findFirst as any) = async () => ({
        id: 'session-concurrency-test',
        terminalId: 'TERM-TEST',
        sectionId: 'section-test',
        startTime: new Date(),
        lateThresholdMins: 15,
        cutThresholdMins: 45,
        section: {
          sectionCode: 'TEST101',
          courseName: 'Testing',
          roomNumber: 'LAB-101',
        },
      });

      // Mock user lookup
      (prisma.user.findUnique as any) = async () => ({
        id: 'student-collision-test',
        studentId: '2026-TEST-001',
        firstName: 'Race',
        lastName: 'Condition',
        email: 'race@orchestra.edu',
        rfidUid: 'AABBCCDD',
      });

      // Mock enrollment check -> student is enrolled
      (prisma.enrollment.findUnique as any) = async () => ({
        studentId: 'student-collision-test',
        sectionId: 'section-test',
      });

      // In a race condition: findUnique returns null for both threads
      (prisma.attendanceLog.findUnique as any) = async () => null;

      // The second concurrent thread experiences P2002 unique constraint violation
      (prisma.attendanceLog.create as any) = async () => {
        const p2002Error: any = new Error('Unique constraint failed on the fields: (sessionId, studentId)');
        p2002Error.code = 'P2002';
        throw p2002Error;
      };

      const result = await hardwareService.processCardTap('TERM-TEST', 'AABBCCDD');

      assert.equal(result.statusCode, 409);
      assert.equal(result.success, false);
      assert.equal(result.code, 'ALREADY_RECORDED');
      assert.match(result.message, /ALREADY RECORDED|checked in/i);
    } finally {
      // Restore Prisma methods
      (prisma.session.findFirst as any) = originalFindSession;
      (prisma.user.findUnique as any) = originalFindUser;
      (prisma.enrollment.findUnique as any) = originalFindEnrollment;
      (prisma.attendanceLog.findUnique as any) = originalFindUnique;
      (prisma.attendanceLog.create as any) = originalCreate;
    }
  });

  await t.test('verifyKeypadOtp returns 409 ALREADY_RECORDED when Prisma throws P2002 on attendanceLog creation', async () => {
    const originalFindSession = prisma.session.findFirst;
    const originalFindOtp = prisma.otpCode.findFirst;
    const originalUpdateOtp = prisma.otpCode.update;
    const originalFindLog = prisma.attendanceLog.findUnique;
    const originalCreateLog = prisma.attendanceLog.create;

    try {
      (prisma.session.findFirst as any) = async () => ({
        id: 'session-concurrency-test',
        terminalId: 'TERM-TEST',
        sectionId: 'section-test',
        startTime: new Date(),
        lateThresholdMins: 15,
        cutThresholdMins: 45,
      });

      (prisma.otpCode.findFirst as any) = async () => ({
        id: 'otp-test-id',
        code: '123456',
        sessionId: 'session-concurrency-test',
        studentId: 'student-otp-test',
        isUsed: false,
        expiresAt: new Date(Date.now() + 60000),
        failedAttempts: 0,
        student: {
          id: 'student-otp-test',
          firstName: 'Concurrent',
          lastName: 'Student',
          email: 'concurrent@orchestra.edu',
          studentId: '2026-OTP-001',
        },
      });

      (prisma.otpCode.update as any) = async () => ({});
      (prisma.attendanceLog.findUnique as any) = async () => null;

      (prisma.attendanceLog.create as any) = async () => {
        const p2002Error: any = new Error('Unique constraint failed on the fields: (sessionId, studentId)');
        p2002Error.code = 'P2002';
        throw p2002Error;
      };

      const result = await otpService.verifyKeypadOtp('TERM-TEST', '123456');

      assert.equal(result.statusCode, 409);
      assert.equal(result.success, false);
      assert.equal(result.code, 'ALREADY_RECORDED');
    } finally {
      (prisma.session.findFirst as any) = originalFindSession;
      (prisma.otpCode.findFirst as any) = originalFindOtp;
      (prisma.otpCode.update as any) = originalUpdateOtp;
      (prisma.attendanceLog.findUnique as any) = originalFindLog;
      (prisma.attendanceLog.create as any) = originalCreateLog;
    }
  });

  await t.test('processOfflineSync handles cardUid and rfidUid polymorphically', async () => {
    const originalFindSession = prisma.session.findFirst;
    const originalFindUser = prisma.user.findUnique;
    const originalFindLog = prisma.attendanceLog.findUnique;
    const originalCreateLog = prisma.attendanceLog.create;
    const originalGetActive = sessionService.getActiveSession;

    const loggedIds: string[] = [];

    try {
      (prisma.session.findFirst as any) = async () => ({
        id: 'session-offline-test',
        terminalId: 'TERM-OFFLINE',
        startTime: new Date(),
        lateThresholdMins: 15,
        cutThresholdMins: 45,
        section: {
          sectionCode: 'OFFLINE101',
          courseName: 'Offline Systems',
          roomNumber: 'LAB-202',
          enrollments: [{ studentId: 'student-1' }, { studentId: 'student-2' }],
        },
      });

      (prisma.user.findUnique as any) = async ({ where }: any) => {
        if (where.rfidUid === 'CARD1111') {
          return { id: 'student-1', firstName: 'John', lastName: 'Doe', email: 'john@orchestra.edu' };
        }
        if (where.rfidUid === 'RFID2222') {
          return { id: 'student-2', firstName: 'Jane', lastName: 'Doe', email: 'jane@orchestra.edu' };
        }
        return null;
      };

      (prisma.attendanceLog.findUnique as any) = async () => null;

      (prisma.attendanceLog.create as any) = async ({ data }: any) => {
        loggedIds.push(data.studentId);
        return {
          id: `log-uuid-${data.studentId}`,
          ...data,
        };
      };

      (sessionService.getActiveSession as any) = async () => ({
        stats: { totalEnrolled: 2 },
        roster: [],
      });

      // Both cardUid and rfidUid records in payload
      const result = await hardwareService.processOfflineSync('TERM-OFFLINE', {
        records: [
          { cardUid: 'CARD1111', timestamp: new Date().toISOString() },
          { rfidUid: 'RFID2222', timestamp: new Date().toISOString() },
        ],
      });

      assert.equal(result.syncedCount, 2);
      assert.deepEqual(loggedIds, ['student-1', 'student-2']);
    } finally {
      (prisma.session.findFirst as any) = originalFindSession;
      (prisma.user.findUnique as any) = originalFindUser;
      (prisma.attendanceLog.findUnique as any) = originalFindLog;
      (prisma.attendanceLog.create as any) = originalCreateLog;
      (sessionService.getActiveSession as any) = originalGetActive;
    }
  });
});
