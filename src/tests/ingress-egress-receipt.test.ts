import test from 'node:test';
import assert from 'node:assert/strict';
import { hardwareService } from '../services/hardware.service.js';
import { mailerService } from '../services/mailer.service.js';
import prisma from '../config/prisma.js';
import { AuthMethod, AttendanceStatus } from '@prisma/client';

test('Dual Ingress / Egress Tracking & Digital Email Receipts', async (t) => {
  const originalFindUnique = prisma.attendanceLog.findUnique;
  const originalCreate = prisma.attendanceLog.create;
  const originalUpdate = prisma.attendanceLog.update;
  const originalFindSession = prisma.session.findFirst;
  const originalFindUser = prisma.user.findUnique;
  const originalFindEnrollment = prisma.enrollment.findUnique;
  const originalSendIngress = mailerService.sendIngressReceipt;
  const originalSendEgress = mailerService.sendEgressReceipt;

  t.afterEach(() => {
    (prisma.attendanceLog.findUnique as any) = originalFindUnique;
    (prisma.attendanceLog.create as any) = originalCreate;
    (prisma.attendanceLog.update as any) = originalUpdate;
    (prisma.session.findFirst as any) = originalFindSession;
    (prisma.user.findUnique as any) = originalFindUser;
    (prisma.enrollment.findUnique as any) = originalFindEnrollment;
    (mailerService.sendIngressReceipt as any) = originalSendIngress;
    (mailerService.sendEgressReceipt as any) = originalSendEgress;
  });

  await t.test('1. First tap records Ingress (ACCESS_GRANTED)', async () => {
    const sessionStartTime = new Date(Date.now() - 5 * 60 * 1000); // 5 mins ago

    (prisma.session.findFirst as any) = async () => ({
      id: 'session-ingress-01',
      terminalId: 'TERM-CL304',
      sectionId: 'section-test-01',
      startTime: sessionStartTime,
      lateThresholdMins: 15,
      cutThresholdMins: 45,
      attendanceLogs: [],
      faculty: {
        id: 'faculty-01',
        firstName: 'Ada',
        lastName: 'Lovelace',
        role: 'FACULTY',
        email: 'ada@orchestra.edu',
      },
      section: {
        sectionCode: 'CS101-BSCS1A',
        courseName: 'Computer Architecture',
        roomNumber: 'LAB-304',
      },
    });

    (prisma.user.findUnique as any) = async () => ({
      id: 'student-uuid-01',
      studentId: '2026-CS-0001',
      firstName: 'Alan',
      lastName: 'Turing',
      email: 'alan@orchestra.edu',
      rfidUid: 'E1E2E3E4',
      role: 'STUDENT',
    });

    (prisma.enrollment.findUnique as any) = async () => ({
      studentId: 'student-uuid-01',
      sectionId: 'section-test-01',
    });

    (prisma.attendanceLog.findUnique as any) = async () => null;

    let createdRecord: any = null;
    (prisma.attendanceLog.create as any) = async (args: any) => {
      createdRecord = args.data;
      return {
        id: 'log-ingress-01',
        ...args.data,
      };
    };

    let ingressReceiptDispatched = false;
    (mailerService.sendIngressReceipt as any) = async (params: any) => {
      ingressReceiptDispatched = true;
      assert.equal(params.studentEmail, 'alan@orchestra.edu');
      assert.equal(params.courseName, 'Computer Architecture');
      return true;
    };

    const result = await hardwareService.processCardTap('TERM-CL304', 'E1E2E3E4');

    assert.equal(result.statusCode, 200);
    assert.equal(result.success, true);
    assert.equal(result.code, 'ACCESS_GRANTED');
    assert.equal(createdRecord.status, AttendanceStatus.PRESENT);
    assert.ok(createdRecord.tapTimestamp);
    assert.equal(createdRecord.egressTimestamp, null);
    assert.equal(createdRecord.totalMinutesAttended, null);
    assert.equal(ingressReceiptDispatched, true);
  });

  await t.test('2. Immediate re-tap within pacing cooldown triggers anti-passback (ALREADY_RECORDED)', async () => {
    const recentTapTime = new Date(Date.now() - 1000); // 1 second ago

    (prisma.session.findFirst as any) = async () => ({
      id: 'session-ingress-01',
      terminalId: 'TERM-CL304',
      sectionId: 'section-test-01',
      startTime: new Date(Date.now() - 2000),
      lateThresholdMins: 15,
      cutThresholdMins: 45,
      section: {
        sectionCode: 'CS101-BSCS1A',
        courseName: 'Computer Architecture',
        roomNumber: 'LAB-304',
      },
    });

    (prisma.user.findUnique as any) = async () => ({
      id: 'student-uuid-01',
      studentId: '2026-CS-0001',
      firstName: 'Alan',
      lastName: 'Turing',
      email: 'alan@orchestra.edu',
      rfidUid: 'E1E2E3E4',
      role: 'STUDENT',
    });

    (prisma.enrollment.findUnique as any) = async () => ({
      studentId: 'student-uuid-01',
      sectionId: 'section-test-01',
    });

    (prisma.attendanceLog.findUnique as any) = async () => ({
      id: 'log-ingress-01',
      sessionId: 'session-ingress-01',
      studentId: 'student-uuid-01',
      status: AttendanceStatus.PRESENT,
      authMethod: AuthMethod.RFID_TAP,
      tapTimestamp: recentTapTime,
      egressTimestamp: null,
      totalMinutesAttended: null,
    });

    const result = await hardwareService.processCardTap('TERM-CL304', 'E1E2E3E4');

    assert.equal(result.statusCode, 409);
    assert.equal(result.success, false);
    assert.equal(result.code, 'ALREADY_RECORDED');
  });

  await t.test('3. Subsequent tap after cooldown records Egress (EGRESS_RECORDED)', async () => {
    // Student checked in 90 minutes ago
    const ingressTime = new Date(Date.now() - 90 * 60 * 1000);

    (prisma.session.findFirst as any) = async () => ({
      id: 'session-ingress-01',
      terminalId: 'TERM-CL304',
      sectionId: 'section-test-01',
      startTime: new Date(Date.now() - 100 * 60 * 1000),
      lateThresholdMins: 15,
      cutThresholdMins: 45,
      attendanceLogs: [],
      faculty: {
        id: 'faculty-01',
        firstName: 'Ada',
        lastName: 'Lovelace',
        role: 'FACULTY',
        email: 'ada@orchestra.edu',
      },
      section: {
        sectionCode: 'CS101-BSCS1A',
        courseName: 'Computer Architecture',
        roomNumber: 'LAB-304',
      },
    });

    (prisma.user.findUnique as any) = async () => ({
      id: 'student-uuid-01',
      studentId: '2026-CS-0001',
      firstName: 'Alan',
      lastName: 'Turing',
      email: 'alan@orchestra.edu',
      rfidUid: 'E1E2E3E4',
      role: 'STUDENT',
    });

    (prisma.enrollment.findUnique as any) = async () => ({
      studentId: 'student-uuid-01',
      sectionId: 'section-test-01',
    });

    (prisma.attendanceLog.findUnique as any) = async () => ({
      id: 'log-ingress-01',
      sessionId: 'session-ingress-01',
      studentId: 'student-uuid-01',
      status: AttendanceStatus.PRESENT,
      authMethod: AuthMethod.RFID_TAP,
      tapTimestamp: ingressTime,
      egressTimestamp: null,
      totalMinutesAttended: null,
    });

    let updatedRecord: any = null;
    (prisma.attendanceLog.update as any) = async (args: any) => {
      updatedRecord = args.data;
      return {
        id: 'log-ingress-01',
        sessionId: 'session-ingress-01',
        studentId: 'student-uuid-01',
        status: AttendanceStatus.PRESENT,
        authMethod: AuthMethod.RFID_TAP,
        tapTimestamp: ingressTime,
        egressTimestamp: args.data.egressTimestamp,
        totalMinutesAttended: args.data.totalMinutesAttended,
        isManualOverride: false,
        overrideReason: null,
      };
    };

    let egressReceiptDispatched = false;
    let egressDurationReceived = 0;
    (mailerService.sendEgressReceipt as any) = async (params: any) => {
      egressReceiptDispatched = true;
      egressDurationReceived = params.totalMinutesAttended;
      assert.equal(params.studentEmail, 'alan@orchestra.edu');
      assert.equal(params.courseName, 'Computer Architecture');
      return true;
    };

    const result = await hardwareService.processCardTap('TERM-CL304', 'E1E2E3E4');

    assert.equal(result.statusCode, 200);
    assert.equal(result.success, true);
    assert.equal(result.code, 'EGRESS_RECORDED');
    assert.ok(result.data.egressTime);
    assert.equal(result.data.totalMinutesAttended, 90);
    assert.equal(updatedRecord.totalMinutesAttended, 90);
    assert.equal(egressReceiptDispatched, true);
    assert.equal(egressDurationReceived, 90);
  });

  await t.test('4a. Rapid re-tap while already egressed acknowledges exit', async () => {
    const ingressTime = new Date(Date.now() - 95 * 60 * 1000);
    const recentEgressTime = new Date(Date.now() - 1000); // 1s ago

    (prisma.session.findFirst as any) = async () => ({
      id: 'session-ingress-01',
      terminalId: 'TERM-CL304',
      sectionId: 'section-test-01',
      startTime: new Date(Date.now() - 100 * 60 * 1000),
      lateThresholdMins: 15,
      cutThresholdMins: 45,
      attendanceLogs: [],
      faculty: {
        id: 'faculty-01',
        firstName: 'Ada',
        lastName: 'Lovelace',
        role: 'FACULTY',
        email: 'ada@orchestra.edu',
      },
      section: {
        sectionCode: 'CS101-BSCS1A',
        courseName: 'Computer Architecture',
        roomNumber: 'LAB-304',
      },
    });

    (prisma.user.findUnique as any) = async () => ({
      id: 'student-uuid-01',
      studentId: '2026-CS-0001',
      firstName: 'Alan',
      lastName: 'Turing',
      email: 'alan@orchestra.edu',
      rfidUid: 'E1E2E3E4',
      role: 'STUDENT',
    });

    (prisma.enrollment.findUnique as any) = async () => ({
      studentId: 'student-uuid-01',
      sectionId: 'section-test-01',
    });

    (prisma.attendanceLog.findUnique as any) = async () => ({
      id: 'log-ingress-01',
      sessionId: 'session-ingress-01',
      studentId: 'student-uuid-01',
      status: AttendanceStatus.PRESENT,
      authMethod: AuthMethod.RFID_TAP,
      tapTimestamp: ingressTime,
      egressTimestamp: recentEgressTime,
      totalMinutesAttended: 95,
    });

    const result = await hardwareService.processCardTap('TERM-CL304', 'E1E2E3E4');

    assert.equal(result.statusCode, 200);
    assert.equal(result.success, true);
    assert.equal(result.code, 'EGRESS_RECORDED');
    assert.match(result.message, /already checked out/i);
    assert.ok(result.data.timeOut);
  });

  await t.test('4b. Subsequent re-tap after cooldown updates egress timestamp without re-sending email', async () => {
    const ingressTime = new Date(Date.now() - 60 * 60 * 1000); // 60 mins ago
    const previousEgressTime = new Date(Date.now() - 10 * 60 * 1000); // 10 mins ago (50 mins attended)

    (prisma.session.findFirst as any) = async () => ({
      id: 'session-ingress-01',
      terminalId: 'TERM-CL304',
      sectionId: 'section-test-01',
      startTime: new Date(Date.now() - 70 * 60 * 1000),
      lateThresholdMins: 15,
      cutThresholdMins: 45,
      attendanceLogs: [],
      faculty: {
        id: 'faculty-01',
        firstName: 'Ada',
        lastName: 'Lovelace',
        role: 'FACULTY',
        email: 'ada@orchestra.edu',
      },
      section: {
        sectionCode: 'CS101-BSCS1A',
        courseName: 'Computer Architecture',
        roomNumber: 'LAB-304',
      },
    });

    (prisma.user.findUnique as any) = async () => ({
      id: 'student-uuid-01',
      studentId: '2026-CS-0001',
      firstName: 'Alan',
      lastName: 'Turing',
      email: 'alan@orchestra.edu',
      rfidUid: 'E1E2E3E4',
      role: 'STUDENT',
    });

    (prisma.enrollment.findUnique as any) = async () => ({
      studentId: 'student-uuid-01',
      sectionId: 'section-test-01',
    });

    (prisma.attendanceLog.findUnique as any) = async () => ({
      id: 'log-ingress-01',
      sessionId: 'session-ingress-01',
      studentId: 'student-uuid-01',
      status: AttendanceStatus.PRESENT,
      authMethod: AuthMethod.RFID_TAP,
      tapTimestamp: ingressTime,
      egressTimestamp: previousEgressTime,
      totalMinutesAttended: 50,
    });

    let updatedRecord: any = null;
    (prisma.attendanceLog.update as any) = async (args: any) => {
      updatedRecord = args.data;
      return {
        id: 'log-ingress-01',
        sessionId: 'session-ingress-01',
        studentId: 'student-uuid-01',
        status: AttendanceStatus.PRESENT,
        authMethod: AuthMethod.RFID_TAP,
        tapTimestamp: ingressTime,
        egressTimestamp: args.data.egressTimestamp,
        totalMinutesAttended: args.data.totalMinutesAttended,
        isManualOverride: false,
        overrideReason: null,
      };
    };

    let duplicateEmailSent = false;
    (mailerService.sendEgressReceipt as any) = async () => {
      duplicateEmailSent = true;
      return true;
    };

    const result = await hardwareService.processCardTap('TERM-CL304', 'E1E2E3E4');

    assert.equal(result.statusCode, 200);
    assert.equal(result.success, true);
    assert.equal(result.code, 'EGRESS_RECORDED');
    assert.match(result.message, /CHECK-OUT UPDATED/i);
    assert.equal(result.data.totalMinutesAttended, 60);
    assert.equal(updatedRecord.totalMinutesAttended, 60);
    assert.equal(duplicateEmailSent, false, 'Should NOT send duplicate email receipt on re-tap');
    assert.ok(result.data.timeOut);
  });

  await t.test('5. MailerService formatDuration formats hours and minutes properly', () => {
    assert.equal(mailerService.formatDuration(0), '0 mins');
    assert.equal(mailerService.formatDuration(45), '45 mins');
    assert.equal(mailerService.formatDuration(60), '1h 0m');
    assert.equal(mailerService.formatDuration(105), '1h 45m');
    assert.equal(mailerService.formatDuration(120), '2h 0m');
  });
});
