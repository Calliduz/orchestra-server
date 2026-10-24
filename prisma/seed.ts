import { PrismaClient, Role, SessionStatus, AttendanceStatus, AuthMethod } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting ORCHESTRA Database Seed...');

  // 1. Clean existing records in reverse dependency order
  console.log('🧹 Purging existing data...');
  await prisma.otpCode.deleteMany();
  await prisma.attendanceLog.deleteMany();
  await prisma.session.deleteMany();
  await prisma.enrollment.deleteMany();
  await prisma.section.deleteMany();
  await prisma.user.deleteMany();

  // 2. Hash default password
  const defaultPassword = await bcrypt.hash('Password123!', 10);

  // 3. Seed Faculty & Admin Users
  console.log('👨‍🏫 Seeding Faculty & Administrators...');
  const faculty1 = await prisma.user.create({
    data: {
      studentId: 'FAC-2026-001',
      email: 'faculty@orchestra.edu',
      password: defaultPassword,
      firstName: 'Karlito',
      lastName: 'Macadat',
      role: Role.FACULTY,
      rfidUid: 'A1B2C3D4', // Faculty Master Badge 1
      department: 'College of Computer Studies',
    },
  });

  const faculty2 = await prisma.user.create({
    data: {
      studentId: 'FAC-2026-002',
      email: 'agbada.faculty@orchestra.edu',
      password: defaultPassword,
      firstName: 'Justine Jay',
      lastName: 'Agbada',
      role: Role.FACULTY,
      rfidUid: 'F4E3D2C1', // Faculty Master Badge 2
      department: 'College of Computer Studies',
    },
  });

  const admin = await prisma.user.create({
    data: {
      studentId: 'ADM-2026-001',
      email: 'admin@orchestra.edu',
      password: defaultPassword,
      firstName: 'System',
      lastName: 'Administrator',
      role: Role.ADMIN,
      rfidUid: '99AA88BB',
      department: 'IT Infrastructure Division',
    },
  });

  console.log(`✅ Created Faculty: ${faculty1.firstName} ${faculty1.lastName} (Master RFID: ${faculty1.rfidUid})`);
  console.log(`✅ Created Faculty: ${faculty2.firstName} ${faculty2.lastName} (Master RFID: ${faculty2.rfidUid})`);

  // 4. Seed Course Section
  console.log('🏫 Seeding Course Sections...');
  const section1 = await prisma.section.create({
    data: {
      sectionCode: 'AR101-BSIT3A',
      courseName: 'Computer Architecture and Organization',
      roomNumber: 'LAB-304',
      terminalId: 'TERM-CL304', // Matches the ESP32 hardware terminal identifier
      facultyId: faculty1.id,
      defaultLateThresholdMins: 15,
      defaultCutThresholdMins: 45,
    },
  });

  console.log(`✅ Created Section: ${section1.sectionCode} - ${section1.courseName} (Terminal: ${section1.terminalId})`);

  // 5. Seed Students (Research Co-Authors and Classmates)
  console.log('🎓 Seeding Student Roster...');
  const studentData = [
    {
      studentId: '2023-0001-CCS',
      email: 'agbada.justine@student.orchestra.edu',
      firstName: 'Justine Jay',
      lastName: 'Agbada',
      rfidUid: '10A1B2C3',
    },
    {
      studentId: '2023-0002-CCS',
      email: 'altichie.rjhay@student.orchestra.edu',
      firstName: 'Rjhay',
      lastName: 'Altichie',
      rfidUid: '20B2C3D4',
    },
    {
      studentId: '2023-0003-CCS',
      email: 'cabunoc.josh@student.orchestra.edu',
      firstName: 'Josh Lister',
      lastName: 'Cabunoc',
      rfidUid: '30C3D4E5',
    },
    {
      studentId: '2023-0004-CCS',
      email: 'dalupang.clever@student.orchestra.edu',
      firstName: 'Juztyne Clever',
      lastName: 'Dalupang',
      rfidUid: '40D4E5F6',
    },
    {
      studentId: '2023-0005-CCS',
      email: 'macadat.karlito@student.orchestra.edu',
      firstName: 'Karlito',
      lastName: 'Macadat Jr.',
      rfidUid: '50E5F6A7',
    },
    {
      studentId: '2023-0006-CCS',
      email: 'malate.denmark@student.orchestra.edu',
      firstName: 'Denmark',
      lastName: 'Malate',
      rfidUid: '60F6A7B8',
    },
    {
      studentId: '2023-0007-CCS',
      email: 'santos.maria@student.orchestra.edu',
      firstName: 'Maria Clara',
      lastName: 'Santos',
      rfidUid: '70A7B8C9',
    },
    {
      studentId: '2023-0008-CCS',
      email: 'reyes.juan@student.orchestra.edu',
      firstName: 'Juan Carlos',
      lastName: 'Reyes',
      rfidUid: '80B8C9D0',
    },
    {
      studentId: '2023-0009-CCS',
      email: 'delacruz.bea@student.orchestra.edu',
      firstName: 'Bea',
      lastName: 'Dela Cruz',
      rfidUid: '90C9D0E1',
    },
    {
      studentId: '2023-0010-CCS',
      email: 'tan.lance@student.orchestra.edu',
      firstName: 'Lance Christian',
      lastName: 'Tan',
      rfidUid: '01D0E1F2',
    },
    {
      studentId: '2023-0011-CCS',
      email: 'garcia.sofia@student.orchestra.edu',
      firstName: 'Sofia Nicole',
      lastName: 'Garcia',
      rfidUid: '12E1F2A3',
    },
    {
      studentId: '2023-0012-CCS',
      email: 'bautista.paolo@student.orchestra.edu',
      firstName: 'Paolo Miguel',
      lastName: 'Bautista',
      rfidUid: '23F2A3B4',
    },
  ];

  const createdStudents = [];
  for (const s of studentData) {
    const student = await prisma.user.create({
      data: {
        studentId: s.studentId,
        email: s.email,
        password: defaultPassword,
        firstName: s.firstName,
        lastName: s.lastName,
        role: Role.STUDENT,
        rfidUid: s.rfidUid,
        department: 'College of Computer Studies',
      },
    });
    createdStudents.push(student);

    // Enroll each student into Section AR101-BSIT3A
    await prisma.enrollment.create({
      data: {
        studentId: student.id,
        sectionId: section1.id,
      },
    });
  }

  console.log(`✅ Seeded and enrolled ${createdStudents.length} students into ${section1.sectionCode}.`);

  // 6. Seed a Past Completed Session (Historical Demonstration)
  console.log('📜 Seeding an archived past session with historical attendance logs...');
  const pastSessionStartTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago, 9:00 AM
  const pastSessionEndTime = new Date(pastSessionStartTime.getTime() + 90 * 60 * 1000); // 1.5 hours later

  const pastSession = await prisma.session.create({
    data: {
      sectionId: section1.id,
      facultyId: faculty1.id,
      terminalId: section1.terminalId,
      status: SessionStatus.CLOSED,
      startTime: pastSessionStartTime,
      endTime: pastSessionEndTime,
      lateThresholdMins: 15,
      cutThresholdMins: 45,
      reportSentAt: pastSessionEndTime,
    },
  });

  // Assign diverse historical attendance statuses across the roster:
  // 7 On-time Present, 2 Late, 1 Cut, 1 Excused (Clinic), 1 Absent
  const pastLogs = [
    { student: createdStudents[0], status: AttendanceStatus.PRESENT, mins: 3, method: AuthMethod.RFID_TAP },
    { student: createdStudents[1], status: AttendanceStatus.PRESENT, mins: 5, method: AuthMethod.RFID_TAP },
    { student: createdStudents[2], status: AttendanceStatus.PRESENT, mins: 8, method: AuthMethod.RFID_TAP },
    { student: createdStudents[3], status: AttendanceStatus.PRESENT, mins: 12, method: AuthMethod.RFID_TAP },
    { student: createdStudents[4], status: AttendanceStatus.PRESENT, mins: 14, method: AuthMethod.KEYPAD_OTP },
    { student: createdStudents[5], status: AttendanceStatus.PRESENT, mins: 7, method: AuthMethod.RFID_TAP },
    { student: createdStudents[6], status: AttendanceStatus.PRESENT, mins: 10, method: AuthMethod.RFID_TAP },
    { student: createdStudents[7], status: AttendanceStatus.LATE, mins: 22, method: AuthMethod.RFID_TAP },
    { student: createdStudents[8], status: AttendanceStatus.LATE, mins: 31, method: AuthMethod.RFID_TAP },
    { student: createdStudents[9], status: AttendanceStatus.CUT, mins: 52, method: AuthMethod.RFID_TAP },
    {
      student: createdStudents[10],
      status: AttendanceStatus.EXCUSED,
      mins: 0,
      method: AuthMethod.MANUAL_OVERRIDE,
      overrideReason: 'University Clinic Medical Referral',
      overriddenById: faculty1.id,
    },
    { student: createdStudents[11], status: AttendanceStatus.ABSENT, mins: null, method: AuthMethod.AUTO_ABSENT },
  ];

  for (const log of pastLogs) {
    const tapTime = log.mins !== null ? new Date(pastSessionStartTime.getTime() + log.mins * 60 * 1000) : null;
    await prisma.attendanceLog.create({
      data: {
        sessionId: pastSession.id,
        studentId: log.student.id,
        status: log.status,
        authMethod: log.method,
        tapTimestamp: tapTime,
        reverseReceiptSent: log.status !== AttendanceStatus.ABSENT,
        receiptSentAt: tapTime,
        isManualOverride: log.method === AuthMethod.MANUAL_OVERRIDE,
        overrideReason: log.overrideReason || null,
        overriddenById: log.overriddenById || null,
        overriddenAt: log.overriddenById ? pastSessionStartTime : null,
      },
    });
  }

  console.log(`✅ Seeded historical session ${pastSession.id} with 12 attendance records.`);

  console.log('\n======================================================');
  console.log('🎉 ORCHESTRA SEEDING COMPLETE');
  console.log('======================================================');
  console.log('Faculty 1: faculty@orchestra.edu | Pass: Password123! | Master RFID: A1B2C3D4');
  console.log('Faculty 2: agbada.faculty@orchestra.edu | Pass: Password123! | Master RFID: F4E3D2C1');
  console.log('Admin:     admin@orchestra.edu   | Pass: Password123! | Master RFID: 99AA88BB');
  console.log('Section:   AR101-BSIT3A (Terminal: TERM-CL304)');
  console.log('Terminal State: LOCKED (Waiting for Faculty Master Badge A1B2C3D4)');
  console.log('======================================================\n');
}

main()
  .catch((e) => {
    console.error('❌ Seeding error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
