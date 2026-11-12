import 'dotenv/config';
import prisma from '../src/config/prisma.js';
import { env } from '../src/config/env.js';
import { Role } from '@prisma/client';

const BASE_URL = `http://localhost:${env.PORT || 5000}/api/v1`;
const API_KEY = env.HARDWARE_API_KEY || 'ORCHESTRA_ESP32_SECURE_TOKEN_2026';
const TERMINAL_ID = 'TERM-CL304';

interface TestResult {
  step: string;
  passed: boolean;
  details?: any;
  error?: string;
}

const results: TestResult[] = [];

function assert(condition: boolean, step: string, details?: any) {
  if (condition) {
    console.log(`✅ [PASS] ${step}`);
    results.push({ step, passed: true, details });
  } else {
    console.error(`❌ [FAIL] ${step}`, details);
    results.push({ step, passed: false, details, error: 'Assertion failed' });
    throw new Error(`Test assertion failed: ${step}`);
  }
}

async function api(path: string, options: RequestInit = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
    ...(options.headers || {}),
  };
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runComprehensiveTest() {
  console.log('\n================================================================');
  console.log('🧪 ORCHESTRA COMPREHENSIVE END-TO-END TEST SUITE');
  console.log(`📡 Target API: ${BASE_URL}`);
  console.log(`🏷️ Terminal: ${TERMINAL_ID}`);
  console.log('================================================================\n');

  // Step 0: DB Context Audit
  console.log('--- [STEP 0: DB Context Audit] ---');
  const section = await prisma.section.findFirst({
    where: { terminalId: TERMINAL_ID },
    include: {
      faculty: true,
      enrollments: {
        include: {
          student: true,
        },
      },
    },
  });
  assert(!!section, `Section configured for terminal ${TERMINAL_ID}`, { sectionCode: section?.sectionCode });
  assert(section!.enrollments.length >= 2, 'At least 2 students enrolled in section for testing', { count: section!.enrollments.length });

  const studentA = section!.enrollments[0].student;
  const studentB = section!.enrollments[1].student;
  console.log(`Faculty: ${section!.faculty.firstName} ${section!.faculty.lastName} (${section!.faculty.rfidUid})`);
  console.log(`Enrolled Student A: ${studentA.firstName} ${studentA.lastName} (${studentA.rfidUid})`);
  console.log(`Enrolled Student B: ${studentB.firstName} ${studentB.lastName} (${studentB.rfidUid})`);

  // Step 1: Terminal Status API Check
  console.log('\n--- [STEP 1: Terminal Status API] ---');
  const statusRes = await api(`/hardware/status/${TERMINAL_ID}`);
  assert(statusRes.status === 200, 'GET /hardware/status/:terminalId returns 200 OK');
  assert(statusRes.data.success === true, 'Terminal status response indicates success');
  assert(Array.isArray(statusRes.data.authorizedFaculty), 'Authorized faculty list provided to terminal');

  // Close any pre-existing dangling open session to start from a clean slate
  const openSessions = await prisma.session.findMany({
    where: { terminalId: TERMINAL_ID, status: 'OPEN' },
  });
  if (openSessions.length > 0) {
    console.log(`Cleaning up ${openSessions.length} existing open session(s)...`);
    for (const s of openSessions) {
      await prisma.session.update({
        where: { id: s.id },
        data: { status: 'CLOSED', endTime: new Date() },
      });
    }
  }

  // Step 2: Verify Terminal is Locked When No Session is Open
  console.log('\n--- [STEP 2: Locked State Verification] ---');
  const lockedStatusRes = await api(`/hardware/status/${TERMINAL_ID}`);
  assert(lockedStatusRes.data.isLocked === true, 'Terminal is LOCKED when no session is open');

  const lockedTapRes = await api('/hardware/tap', {
    method: 'POST',
    body: JSON.stringify({
      rfidUid: studentA.rfidUid,
      terminalId: TERMINAL_ID,
    }),
  });
  assert(lockedTapRes.status === 403, 'Student tap while terminal locked returns HTTP 403');
  assert(lockedTapRes.data.code === 'SESSION_LOCKED', 'Student tap response code is SESSION_LOCKED');

  // Step 3: Faculty Card Tap - Open Session
  console.log('\n--- [STEP 3: Faculty Badge Session Activation] ---');
  const facultyTapRes = await api('/hardware/tap', {
    method: 'POST',
    body: JSON.stringify({
      rfidUid: section!.faculty.rfidUid,
      terminalId: TERMINAL_ID,
    }),
  });
  assert(facultyTapRes.status === 200, 'Faculty tap returns HTTP 200');
  assert(facultyTapRes.data.code === 'SESSION_STARTED', 'Faculty tap initiates SESSION_STARTED');
  assert(facultyTapRes.data.data.sectionCode === section!.sectionCode, 'Active section matches section code');

  const activeSession = await prisma.session.findFirst({
    where: { terminalId: TERMINAL_ID, status: 'OPEN' },
  });
  assert(!!activeSession, 'Active session created in database');
  console.log(`Active Session ID: ${activeSession!.id}`);

  // Step 4: Student A Tap - Attendance Check-In (PRESENT)
  console.log('\n--- [STEP 4: Student Attendance Check-In (Student A)] ---');
  const studentATapRes = await api('/hardware/tap', {
    method: 'POST',
    body: JSON.stringify({
      rfidUid: studentA.rfidUid,
      terminalId: TERMINAL_ID,
    }),
  });
  assert(studentATapRes.status === 200, 'Student A check-in returns HTTP 200');
  assert(studentATapRes.data.code === 'ACCESS_GRANTED', 'Student A response code is ACCESS_GRANTED');
  assert(
    studentATapRes.data.data.status === 'PRESENT' || studentATapRes.data.data.status === 'LATE',
    'Student marked PRESENT or LATE'
  );

  const logStudentA = await prisma.attendanceLog.findFirst({
    where: { sessionId: activeSession!.id, studentId: studentA.id },
  });
  assert(!!logStudentA, 'Attendance log for Student A persisted in DB');

  // Step 5: Anti-Passback Cooldown / Duplicate Tap Protection
  console.log('\n--- [STEP 5: Anti-Passback / Duplicate Tap Interlock] ---');
  const studentADupRes = await api('/hardware/tap', {
    method: 'POST',
    body: JSON.stringify({
      rfidUid: studentA.rfidUid,
      terminalId: TERMINAL_ID,
    }),
  });
  assert(studentADupRes.status === 409, 'Immediate second tap returns HTTP 409 Conflict');
  assert(studentADupRes.data.code === 'ALREADY_RECORDED', 'Duplicate tap rejected with ALREADY_RECORDED code');
  assert(studentADupRes.status > 0, 'Firmware contract: HTTP 409 is a valid response, not transport offline failure');

  // Step 6: Unregistered RFID Card Handling
  console.log('\n--- [STEP 6: Unregistered Card Rejection] ---');
  const unregRes = await api('/hardware/tap', {
    method: 'POST',
    body: JSON.stringify({
      rfidUid: 'DEADBEEF',
      terminalId: TERMINAL_ID,
    }),
  });
  assert(unregRes.status === 404, 'Unknown card returns HTTP 404 Not Found');
  assert(unregRes.data.code === 'UNREGISTERED_CARD', 'Unknown card code is UNREGISTERED_CARD');

  // Step 7: Non-Enrolled Student Card Handling
  console.log('\n--- [STEP 7: Non-Enrolled Student Rejection] ---');
  const nonEnrolledStudent = await prisma.user.findFirst({
    where: {
      role: Role.STUDENT,
      rfidUid: { not: null },
      enrollments: {
        none: {
          sectionId: section!.id,
        },
      },
    },
  });
  if (nonEnrolledStudent) {
    const nonEnrollRes = await api('/hardware/tap', {
      method: 'POST',
      body: JSON.stringify({
        rfidUid: nonEnrolledStudent.rfidUid,
        terminalId: TERMINAL_ID,
      }),
    });
    assert(nonEnrollRes.status === 403, 'Non-enrolled student returns HTTP 403 Forbidden');
    assert(nonEnrollRes.data.code === 'NOT_ENROLLED', 'Non-enrolled student code is NOT_ENROLLED');
  } else {
    console.log('Skipping non-enrolled student test (all students enrolled in this section).');
  }

  // Step 8: Keypad OTP Backup Check-In (Student B)
  console.log('\n--- [STEP 8: Emergency Keypad OTP Check-In] ---');
  const testOtp = '849201';
  // Clear any existing OTP for this test
  await prisma.otpCode.deleteMany({ where: { code: testOtp } });
  await prisma.otpCode.create({
    data: {
      code: testOtp,
      studentId: studentB.id,
      sessionId: activeSession!.id,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 mins
      isUsed: false,
    },
  });

  const otpRes = await api('/hardware/otp', {
    method: 'POST',
    body: JSON.stringify({
      code: testOtp,
      terminalId: TERMINAL_ID,
    }),
  });
  assert(otpRes.status === 200, 'Valid keypad OTP returns HTTP 200');
  assert(otpRes.data.code === 'OTP_GRANTED', 'Keypad OTP code is OTP_GRANTED');
  assert(
    otpRes.data.data.status === 'PRESENT' || otpRes.data.data.status === 'LATE',
    'Keypad OTP marks student attendance'
  );

  // Replay Attack: Using consumed OTP
  const replayOtpRes = await api('/hardware/otp', {
    method: 'POST',
    body: JSON.stringify({
      code: testOtp,
      terminalId: TERMINAL_ID,
    }),
  });
  assert(replayOtpRes.status === 400, 'Replayed/Consumed OTP returns HTTP 400 Bad Request');

  // Step 9: Offline Ingress & Active Session Safety Guard
  console.log('\n--- [STEP 9: Offline Ingress & Guard Against Unwanted Session Termination] ---');
  
  // Guard Test: Malicious / Accidental CLOSE action with empty faculty UID while session is OPEN
  const fakeCloseSyncRes = await api('/hardware/offline-sync', {
    method: 'POST',
    body: JSON.stringify({
      terminalId: TERMINAL_ID,
      sessionAction: 'CLOSE',
      facultyUid: '', // Missing faculty UID
      records: [],
    }),
  });
  assert(fakeCloseSyncRes.status === 200, 'Offline sync request processed');
  
  const sessionAfterFakeClose = await prisma.session.findUnique({
    where: { id: activeSession!.id },
  });
  assert(sessionAfterFakeClose?.status === 'OPEN', 'Active session remains OPEN despite sync sessionAction: CLOSE (ownership guard active)');

  // Offline Ingress Test: Sync buffered student attendance
  const studentC = section!.enrollments.length > 2 ? section!.enrollments[2].student : null;
  if (studentC) {
    const offlineTimestamp = new Date(Date.now() - 60000).toISOString();
    const offlineIngressRes = await api('/hardware/offline-sync', {
      method: 'POST',
      body: JSON.stringify({
        terminalId: TERMINAL_ID,
        sessionAction: 'CONTINUE',
        facultyUid: '',
        records: [
          {
            rfidUid: studentC.rfidUid,
            timestamp: offlineTimestamp,
          },
        ],
      }),
    });
    assert(offlineIngressRes.status === 200, 'Offline tap ingress returns HTTP 200');
    assert(offlineIngressRes.data.syncedCount === 1, 'Offline record successfully ingested (syncedCount === 1)');

    const logStudentC = await prisma.attendanceLog.findFirst({
      where: { sessionId: activeSession!.id, studentId: studentC.id },
    });
    assert(!!logStudentC, 'Offline attendance log persisted in DB for Student C');
  }

  // Step 10: Faculty Session Closure & Automated Report Generation
  console.log('\n--- [STEP 10: Faculty Session Closure & Report Generation] ---');
  // Debounce guard sleep if needed
  await sleep(1000);
  const facultyCloseTapRes = await api('/hardware/tap', {
    method: 'POST',
    body: JSON.stringify({
      rfidUid: section!.faculty.rfidUid,
      terminalId: TERMINAL_ID,
    }),
  });
  assert(facultyCloseTapRes.status === 200, 'Faculty second tap returns HTTP 200');
  assert(facultyCloseTapRes.data.code === 'SESSION_CLOSED', 'Faculty tap triggers SESSION_CLOSED');

  const closedSession = await prisma.session.findUnique({
    where: { id: activeSession!.id },
  });
  assert(closedSession?.status === 'CLOSED', 'Session marked CLOSED in database');
  assert(closedSession?.endTime !== null, 'Session endTime populated in database');

  // Verify Terminal Status after Closure
  const finalStatusRes = await api(`/hardware/status/${TERMINAL_ID}`);
  assert(finalStatusRes.data.isLocked === true, 'Terminal returned to LOCKED state after faculty closure');

  console.log('\n================================================================');
  console.log('🎉 ALL END-TO-END TEST SUITE ASSERTIONS PASSED SUCCESSFULLY!');
  console.log(`📊 Summary: ${results.length}/${results.length} checks succeeded.`);
  console.log('================================================================\n');
}

runComprehensiveTest()
  .catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
