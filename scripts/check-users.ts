import 'dotenv/config';
import prisma from '../src/config/prisma.js';

async function check() {
  const users = await prisma.user.findMany({
    select: { id: true, studentId: true, email: true, firstName: true, lastName: true, role: true, rfidUid: true }
  });
  console.log('=== USERS IN DB ===');
  console.table(users);

  const sections = await prisma.section.findMany({
    include: { faculty: true }
  });
  console.log('=== SECTIONS IN DB ===');
  sections.forEach(s => console.log(`${s.sectionCode} (${s.roomNumber}, ${s.terminalId}) -> Faculty: ${s.faculty.firstName} ${s.faculty.lastName} (${s.faculty.id})`));

  const sessions = await prisma.session.findMany({
    include: { section: true, _count: { select: { attendanceLogs: true } } }
  });
  console.log('=== SESSIONS IN DB ===');
  console.log(sessions);
}

check().catch(console.error).finally(() => prisma.$disconnect());
