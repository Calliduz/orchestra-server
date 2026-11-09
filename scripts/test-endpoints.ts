import 'dotenv/config';
import jwt from 'jsonwebtoken';
import prisma from '../src/config/prisma.js';
import { JWT_SECRET } from '../src/config/jwt.js';

async function test() {
  const admin = await prisma.user.findUnique({ where: { email: 'admin@orchestra.edu' } });
  const faculty1 = await prisma.user.findUnique({ where: { email: 'faculty@orchestra.edu' } });
  const faculty2 = await prisma.user.findUnique({ where: { email: 'agbada.faculty@orchestra.edu' } });

  console.log('--- ADMIN CHECK ---');
  const adminSections = await prisma.section.findMany({
    where: admin?.role === 'ADMIN' ? {} : { facultyId: admin?.id },
    include: { faculty: true }
  });
  console.log(`Admin sees ${adminSections.length} sections:`, adminSections.map(s => s.sectionCode));

  console.log('\n--- FACULTY 1 (Prof. Karlito) CHECK ---');
  const f1Sections = await prisma.section.findMany({
    where: { facultyId: faculty1?.id },
    include: { faculty: true }
  });
  console.log(`Prof. Karlito sees ${f1Sections.length} sections:`, f1Sections.map(s => s.sectionCode));

  console.log('\n--- FACULTY 2 (Prof. Justine) CHECK ---');
  const f2Sections = await prisma.section.findMany({
    where: { facultyId: faculty2?.id },
    include: { faculty: true }
  });
  console.log(`Prof. Justine sees ${f2Sections.length} sections:`, f2Sections.map(s => s.sectionCode));

  console.log('\n--- SESSIONS LIST FOR ADMIN ---');
  const adminSessions = await prisma.session.findMany({
    take: 10,
    orderBy: { startTime: 'desc' },
    include: { section: true }
  });
  console.log(`Admin can access ${adminSessions.length} sessions for reports`);
}

test().catch(console.error).finally(() => prisma.$disconnect());

