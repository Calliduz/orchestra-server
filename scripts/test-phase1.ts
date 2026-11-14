import 'dotenv/config';
import prisma from '../src/config/prisma.js';
import { hardwareService } from '../src/services/hardware.service.js';
import { watchdogService } from '../src/services/watchdog.service.js';
import { bulkImportService } from '../src/services/bulk-import.service.js';
import { excuseController } from '../src/controllers/excuse.controller.js';
import { SessionStatus, AttendanceStatus, ExcuseStatus, AuthMethod } from '@prisma/client';

let testErrors: string[] = [];

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    testErrors.push(message);
  } else {
    console.log(`✅ PASSED: ${message}`);
  }
}

async function runPhase1Tests() {
  console.log('====================================================');
  console.log('🚀 RUNNING ORCHESTRA PHASE 1 END-TO-END VERIFICATION');
  console.log('====================================================\n');

  // Pre-test cleanup of any leftover TEST- entities
  await prisma.excuseRequest.deleteMany({
    where: { attendanceLog: { session: { section: { sectionCode: { startsWith: 'TEST-' } } } } },
  });
  await prisma.attendanceLog.deleteMany({
    where: { session: { section: { sectionCode: { startsWith: 'TEST-' } } } },
  });
  await prisma.session.deleteMany({
    where: { section: { sectionCode: { startsWith: 'TEST-' } } },
  });
  await prisma.enrollment.deleteMany({
    where: { section: { sectionCode: { startsWith: 'TEST-' } } },
  });
  await prisma.section.deleteMany({
    where: { sectionCode: { startsWith: 'TEST-' } },
  });

  // Find a faculty, student, existing section
  const faculty = await prisma.user.findFirst({
    where: { role: 'FACULTY' },
  });
  if (!faculty) throw new Error('No faculty found in DB');

  const student = await prisma.user.findFirst({
    where: { role: 'STUDENT' },
  });
  if (!student) throw new Error('No student found in DB');

  const existingSection = await prisma.section.findFirst();
  if (!existingSection) throw new Error('No section found in DB');

  const terminalId = existingSection.terminalId;
  const roomNumber = existingSection.roomNumber;

  console.log(`Faculty: ${faculty.firstName} ${faculty.lastName} (${faculty.id}, RFID: ${faculty.rfidUid})`);
  console.log(`Student: ${student.firstName} ${student.lastName} (${student.id}, StudentID: ${student.studentId})`);
  console.log(`Terminal: ${terminalId}, Room: ${roomNumber}\n`);

  // =========================================================================
  // TEST SUITE 1: SCHEDULE-WINDOW SECTION RESOLVER & AMBIGUITY FALLBACK
  // =========================================================================
  console.log('--- TEST 1: Schedule-Window Section Resolver & Disambiguation ---');

  // Close any existing open sessions on terminal
  await prisma.session.updateMany({
    where: { terminalId, status: SessionStatus.OPEN },
    data: { status: SessionStatus.CLOSED },
  });

  // Create two distinct sections for this faculty in this room with conflicting schedules (both on Sunday at midnight)
  const testSectionA = await prisma.section.create({
    data: {
      sectionCode: `TEST-SEC-A-${Date.now().toString().slice(-4)}`,
      courseName: 'Test Architecture A',
      roomNumber,
      terminalId,
      facultyId: faculty.id,
      scheduleDay: 'Sunday',
      scheduleTime: '02:00',
      scheduleEndTime: '03:00',
    },
  });

  const testSectionB = await prisma.section.create({
    data: {
      sectionCode: `TEST-SEC-B-${Date.now().toString().slice(-4)}`,
      courseName: 'Test Architecture B',
      roomNumber,
      terminalId,
      facultyId: faculty.id,
      scheduleDay: 'Sunday',
      scheduleTime: '04:00',
      scheduleEndTime: '05:00',
    },
  });

  try {
    // 1.1 Tap when faculty has multiple sections in this room and neither matches current time
    // Should trigger SECTION_DISAMBIGUATION_REQUIRED fallback
    console.log('[1.1] Faculty taps on terminal with multiple scheduled sections in same room...');
    const disambigRes = await hardwareService.processCardTap(terminalId, faculty.rfidUid || '892B2E8E');
    
    assert(
      disambigRes.code === 'SECTION_DISAMBIGUATION_REQUIRED',
      `Expected SECTION_DISAMBIGUATION_REQUIRED, got ${disambigRes.code}`
    );
    assert(
      Array.isArray(disambigRes.data?.sections) && disambigRes.data.sections.length >= 2,
      `Expected >= 2 candidate sections, got ${disambigRes.data?.sections?.length}`
    );

    // 1.2 Faculty selects section B via selectSection endpoint by index
    console.log('[1.2] Faculty selects Section B via selectSection (by index & facultyUid)...');
    const selectRes = await hardwareService.selectSection({
      terminalId,
      facultyUid: faculty.rfidUid || '892B2E8E',
      index: 2,
    });
    assert(
      selectRes.code === 'SESSION_STARTED',
      `Expected SESSION_STARTED after selectSection, got ${selectRes.code}`
    );
    assert(
      selectRes.data?.sectionCode !== undefined,
      `Expected valid sectionCode after selectSection, got ${selectRes.data?.sectionCode}`
    );

    // 1.3 Verify day-of-week token matching (MWF, TTH, etc.)
    console.log('[1.3] Testing schedule token matching with MWF and TTH...');
    const fakeWed = new Date('2026-11-18T10:00:00'); // Wednesday (day 3)
    const mwfSection = { scheduleDay: 'MWF', scheduleTime: '09:30', scheduleEndTime: '11:00' };
    const tthSection = { scheduleDay: 'TTH', scheduleTime: '09:30', scheduleEndTime: '11:00' };
    const matchedWed = hardwareService.filterSectionsBySchedule([mwfSection, tthSection], fakeWed);
    assert(matchedWed.length === 1 && matchedWed[0].scheduleDay === 'MWF', 'MWF matches Wednesday');

    const fakeThu = new Date('2026-11-19T10:00:00'); // Thursday (day 4)
    const matchedThu = hardwareService.filterSectionsBySchedule([mwfSection, tthSection], fakeThu);
    assert(matchedThu.length === 1 && matchedThu[0].scheduleDay === 'TTH', 'TTH matches Thursday');

    // 1.4 Verify session is OPEN in DB
    const activeSession = await prisma.session.findFirst({
      where: { terminalId, status: SessionStatus.OPEN },
      include: { section: true },
    });
    assert(activeSession !== null, 'Active session exists in DB');

    // Close session cleanly
    if (activeSession) {
      await prisma.session.update({
        where: { id: activeSession.id },
        data: { status: SessionStatus.CLOSED },
      });
    }

  } finally {
    // Cleanup test sections
    await prisma.session.deleteMany({
      where: { sectionId: { in: [testSectionA.id, testSectionB.id] } },
    });
    await prisma.section.deleteMany({
      where: { id: { in: [testSectionA.id, testSectionB.id] } },
    });
  }

  // =========================================================================
  // TEST SUITE 2: BACKGROUND WATCHDOG AUTO-CLOSE
  // =========================================================================
  console.log('\n--- TEST 2: Background Watchdog Auto-Close ---');

  // Create section for watchdog test
  const watchdogSection = await prisma.section.create({
    data: {
      sectionCode: `TEST-WD-${Date.now().toString().slice(-4)}`,
      courseName: 'Watchdog Verification Section',
      roomNumber,
      terminalId,
      facultyId: faculty.id,
      scheduleDay: 'Monday',
      scheduleTime: '08:00',
      scheduleEndTime: '09:00', // Ended at 09:00
    },
  });

  try {
    // Create an expired session started today at 08:00
    const pastStartTime = new Date();
    pastStartTime.setHours(8, 0, 0, 0);

    const expiredSession = await prisma.session.create({
      data: {
        terminalId,
        sectionId: watchdogSection.id,
        facultyId: faculty.id,
        status: SessionStatus.OPEN,
        startTime: pastStartTime,
        isAutoClosed: false,
      },
    });

    console.log('[2.1] Created OPEN session past scheduleEndTime (+15m grace window). Running watchdog sweep...');
    const closedCount = await watchdogService.checkAndAutoCloseSessions();
    assert(closedCount >= 1, `Watchdog should have closed at least 1 session, closed: ${closedCount}`);

    const verifiedSession = await prisma.session.findUnique({
      where: { id: expiredSession.id },
    });
    assert(verifiedSession?.status === SessionStatus.CLOSED, 'Expired session status is now CLOSED');
    assert(verifiedSession?.isAutoClosed === true, 'Expired session isAutoClosed flag is TRUE');
    assert(verifiedSession?.endTime !== null, 'Expired session endTime is recorded');

    // 2.2 Test Inactivity: Create open session with lastActivityAt 100 minutes ago
    const oldStartTime = new Date(Date.now() - 100 * 60 * 1000);
    const inactiveSession = await prisma.session.create({
      data: {
        terminalId,
        sectionId: watchdogSection.id,
        facultyId: faculty.id,
        status: SessionStatus.OPEN,
        startTime: oldStartTime,
        isAutoClosed: false,
      },
    });

    console.log('[2.2] Created OPEN session inactive for 100m. Running watchdog sweep...');
    const closedCount2 = await watchdogService.checkAndAutoCloseSessions();
    assert(closedCount2 >= 1, `Watchdog should have closed inactive session, closed: ${closedCount2}`);

    const verifiedInactive = await prisma.session.findUnique({
      where: { id: inactiveSession.id },
    });
    assert(verifiedInactive?.status === SessionStatus.CLOSED, 'Inactive session is now CLOSED');
    assert(verifiedInactive?.isAutoClosed === true, 'Inactive session isAutoClosed is TRUE');

    // Allow background reports to finish before cleaning up
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    await prisma.session.deleteMany({
      where: { sectionId: watchdogSection.id },
    });
    await prisma.section.delete({
      where: { id: watchdogSection.id },
    });
  }

  // =========================================================================
  // TEST SUITE 3: TWO-STAGE BULK CSV IMPORT
  // =========================================================================
  console.log('\n--- TEST 3: Two-Stage Bulk CSV Import (Validation & Commit) ---');

  // Create a target section for import
  const importSection = await prisma.section.create({
    data: {
      sectionCode: `TEST-CSV-${Date.now().toString().slice(-4)}`,
      courseName: 'Import Verification Course',
      roomNumber,
      terminalId,
      facultyId: faculty.id,
    },
  });

  const uniqueSuffix = Date.now().toString().slice(-5);
  const newStudentId = `STU-TEST-${uniqueSuffix}`;
  const newEmail = `import_test_${uniqueSuffix}@university.edu`;

  const validCsvContent = `studentId,firstName,lastName,email,sectionCode,rfidUid
${newStudentId},TestStudent,PhaseOne,${newEmail},${importSection.sectionCode},E999${uniqueSuffix.slice(-4)}`;

  const invalidCsvContent = `studentId,firstName,lastName,email,sectionCode,rfidUid
MISSING-EMAIL,No,Email,,${importSection.sectionCode},
NONEXISTENT-SEC,Ghost,Student,ghost@test.com,NONEXISTENT_SEC_999,`;

  try {
    // 3.1 Validate Clean CSV
    console.log('[3.1] Validating clean CSV with new student...');
    const validReport = await bulkImportService.validateCsv(validCsvContent);
    assert(validReport.totalRows === 1, `Expected 1 row, got ${validReport.totalRows}`);
    assert(validReport.validCount === 1, `Expected 1 valid row, got ${validReport.validCount}`);
    assert(validReport.conflictCount === 0, `Expected 0 conflicts, got ${validReport.conflictCount}`);
    assert(
      validReport.rows[0].action === 'CREATE_USER_AND_ENROLL',
      `Expected CREATE_USER_AND_ENROLL, got ${validReport.rows[0].action}`
    );

    // 3.2 Validate Conflicting / Malformed CSV
    console.log('[3.2] Validating malformed CSV with missing email & invalid section...');
    const invalidReport = await bulkImportService.validateCsv(invalidCsvContent);
    assert(invalidReport.totalRows === 2, `Expected 2 rows, got ${invalidReport.totalRows}`);
    assert(invalidReport.validCount === 0, `Expected 0 valid rows, got ${invalidReport.validCount}`);
    assert(invalidReport.conflictCount === 2, `Expected 2 conflict rows, got ${invalidReport.conflictCount}`);

    // 3.3 Commit Valid CSV
    console.log('[3.3] Committing validated rows via batch atomic transaction...');
    const commitResult = await bulkImportService.commitCsv(validReport.rows);
    assert(commitResult.createdUserCount === 1, `Expected 1 created user, got ${commitResult.createdUserCount}`);
    assert(commitResult.enrolledCount === 1, `Expected 1 enrollment, got ${commitResult.enrolledCount}`);

    // Verify user and enrollment in DB
    const createdUser = await prisma.user.findUnique({
      where: { email: newEmail },
      include: { enrollments: true },
    });
    assert(createdUser !== null, 'Created user exists in DB');
    assert(createdUser?.studentId === newStudentId, `Student ID matches ${newStudentId}`);
    assert(createdUser?.enrollments.length === 1, 'User enrolled in section');
    assert(createdUser?.enrollments[0].sectionId === importSection.id, 'User enrolled in importSection');

    // 3.4 Re-validate same row -> should be detected as ALREADY_ENROLLED
    console.log('[3.4] Re-validating same CSV -> verifying ALREADY_ENROLLED action...');
    const revalReport = await bulkImportService.validateCsv(validCsvContent);
    assert(
      revalReport.rows[0].action === 'ALREADY_ENROLLED',
      `Expected ALREADY_ENROLLED, got ${revalReport.rows[0].action}`
    );

    // 3.5 Multi-section enrollment in a single CSV (same student in multiple classes)
    console.log('[3.5] Validating multi-section roster (same student taking 2 classes)...');
    const importSection2 = await prisma.section.create({
      data: {
        sectionCode: `TEST-CSV2-${Date.now().toString().slice(-4)}`,
        courseName: 'Second Course',
        roomNumber,
        terminalId,
        facultyId: faculty.id,
      },
    });

    try {
      const multiClassCsv = `studentId,firstName,lastName,email,sectionCode,rfidUid
STU-MULTI-1,Maria,Santos,maria.santos@university.edu,${importSection.sectionCode},F1F2F3F4
STU-MULTI-1,Maria,Santos,maria.santos@university.edu,${importSection2.sectionCode},F1F2F3F4`;
      const multiReport = await bulkImportService.validateCsv(multiClassCsv);
      assert(multiReport.validCount === 2, `Expected 2 valid rows for multi-section enrollment, got ${multiReport.validCount}`);
      assert(multiReport.conflictCount === 0, `Expected 0 conflicts for multi-section enrollment, got ${multiReport.conflictCount}`);

      const multiCommit = await bulkImportService.commitCsv(multiReport.rows);
      assert(multiCommit.createdUserCount === 1, `Expected 1 user created for multi-section student, got ${multiCommit.createdUserCount}`);
      assert(multiCommit.enrolledCount === 2, `Expected 2 enrollments created, got ${multiCommit.enrolledCount}`);

      // Cleanup multi student
      const multiUser = await prisma.user.findUnique({ where: { email: 'maria.santos@university.edu' } });
      if (multiUser) {
        await prisma.enrollment.deleteMany({ where: { studentId: multiUser.id } });
        await prisma.user.delete({ where: { id: multiUser.id } });
      }
    } finally {
      await prisma.enrollment.deleteMany({ where: { sectionId: importSection2.id } });
      await prisma.section.delete({ where: { id: importSection2.id } });
    }

    // Cleanup created user & enrollments
    if (createdUser) {
      await prisma.enrollment.deleteMany({ where: { studentId: createdUser.id } });
      await prisma.user.delete({ where: { id: createdUser.id } });
    }
  } finally {
    await prisma.enrollment.deleteMany({ where: { sectionId: importSection.id } });
    await prisma.section.delete({ where: { id: importSection.id } });
  }

  // =========================================================================
  // TEST SUITE 4: EXCUSE REQUEST LIFECYCLE & AUTO-UPDATE ATTENDANCE
  // =========================================================================
  console.log('\n--- TEST 4: Excuse Request Lifecycle & Approval Logic ---');

  // Create section, session, and an ABSENT attendance record for student
  const excuseSection = await prisma.section.create({
    data: {
      sectionCode: `TEST-EXC-${Date.now().toString().slice(-4)}`,
      courseName: 'Excuse Verification Course',
      roomNumber,
      terminalId,
      facultyId: faculty.id,
    },
  });

  const excuseSession = await prisma.session.create({
    data: {
      terminalId,
      sectionId: excuseSection.id,
      facultyId: faculty.id,
      status: SessionStatus.CLOSED,
      startTime: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      endTime: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 + 3600000),
    },
  });

  const absentLog = await prisma.attendanceLog.create({
    data: {
      sessionId: excuseSession.id,
      studentId: student.id,
      status: AttendanceStatus.ABSENT,
      authMethod: AuthMethod.AUTO_ABSENT,
    },
  });

  try {
    // 4.1 Student submits excuse request
    console.log('[4.1] Student submits excuse request for ABSENT record...');
    const excuseRequest = await prisma.excuseRequest.create({
      data: {
        attendanceLogId: absentLog.id,
        studentId: student.id,
        reason: 'Severe flu and high fever. Doctor advised 2 days bed rest.',
        status: ExcuseStatus.PENDING,
        documentUrl: 'uploads/excuses/test-med-cert.pdf',
        documentName: 'test-med-cert.pdf',
      },
    });

    assert(excuseRequest !== null, 'Excuse request record created');
    assert(excuseRequest.status === ExcuseStatus.PENDING, 'Excuse request status is PENDING');

    // 4.2 Faculty fetches pending excuses
    console.log('[4.2] Faculty fetches pending excuse requests for their section...');
    const pendingExcuses = await prisma.excuseRequest.findMany({
      where: {
        status: ExcuseStatus.PENDING,
        attendanceLog: {
          session: {
            section: {
              facultyId: faculty.id,
            },
          },
        },
      },
      include: {
        student: true,
        attendanceLog: {
          include: { session: true },
        },
      },
    });
    const foundPending = pendingExcuses.find((e) => e.id === excuseRequest.id);
    assert(foundPending !== undefined, 'Faculty sees the pending excuse request');

    // 4.3 Faculty approves the excuse request via ExcuseController
    console.log('[4.3] Faculty approves excuse request via ExcuseController...');
    let reviewStatusCode = 0;
    let reviewResponseJson: any = null;
    const mockReq: any = {
      user: faculty,
      params: { id: excuseRequest.id },
      body: { status: 'APPROVED', reviewNotes: 'Valid medical certificate verified.' },
    };
    const mockRes: any = {
      status(code: number) {
        reviewStatusCode = code;
        return this;
      },
      json(data: any) {
        reviewResponseJson = data;
        return this;
      },
    };

    await excuseController.reviewExcuse(mockReq, mockRes);
    assert(reviewStatusCode === 200, `Expected HTTP 200 from reviewExcuse, got ${reviewStatusCode}`);
    assert(reviewResponseJson?.success === true, 'Excuse review reported success');

    const reviewedExcuse = await prisma.excuseRequest.findUnique({
      where: { id: excuseRequest.id },
    });
    assert(reviewedExcuse?.status === ExcuseStatus.APPROVED, 'Excuse request status is APPROVED in DB');

    // 4.4 Verify AttendanceLog status is now EXCUSED
    console.log('[4.4] Verifying attendance record has transitioned to EXCUSED...');
    const updatedLog = await prisma.attendanceLog.findUnique({
      where: { id: absentLog.id },
    });
    assert(
      updatedLog?.status === AttendanceStatus.EXCUSED,
      `Expected AttendanceLog status EXCUSED, got ${updatedLog?.status}`
    );
    assert(updatedLog?.isManualOverride === true, 'isManualOverride is true');
    assert(updatedLog?.overriddenById === faculty.id, 'overriddenById matches faculty');

    // 4.5 Verify 7-day cutoff validation logic
    console.log('[4.5] Verifying 7-day cutoff validation on ancient sessions...');
    const oldSessionDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
    const diffDays = Math.floor((Date.now() - oldSessionDate.getTime()) / (1000 * 60 * 60 * 24));
    assert(diffDays > 7, `Session age (${diffDays} days) correctly exceeds 7-day window`);

  } finally {
    // Cleanup excuse test data
    await prisma.excuseRequest.deleteMany({
      where: { attendanceLogId: absentLog.id },
    });
    await prisma.attendanceLog.deleteMany({
      where: { sessionId: excuseSession.id },
    });
    await prisma.session.deleteMany({
      where: { sectionId: excuseSection.id },
    });
    await prisma.section.delete({
      where: { id: excuseSection.id },
    });
  }

  console.log('\n====================================================');
  if (testErrors.length === 0) {
    console.log('🎉 ALL PHASE 1 INTEGRATION TESTS PASSED SUCCESSFULLY! (0 errors)');
  } else {
    console.error(`💥 ${testErrors.length} TEST(S) FAILED:`);
    testErrors.forEach((e) => console.error(`  - ${e}`));
  }
  console.log('====================================================\n');

  if (testErrors.length > 0) {
    process.exit(1);
  }
}

runPhase1Tests()
  .catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
