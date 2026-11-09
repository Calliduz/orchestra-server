import 'dotenv/config';
import { hardwareService } from '../src/services/hardware.service.js';
import prisma from '../src/config/prisma.js';

async function testFullFlow() {
  console.log('=== TEST SUITE: COMPLETE HARDWARE TAP FLOW ===');

  // Ensure clean state
  await prisma.session.updateMany({
    where: { terminalId: 'TERM-CL304', status: 'OPEN' },
    data: { status: 'CLOSED' }
  });

  // 1. Terminal Locked - Student tries to tap
  console.log('\n[1] Student taps on locked terminal (418606B1):');
  const res1 = await hardwareService.processCardTap('TERM-CL304', '418606B1');
  console.log(`Result: code=${res1.code}, status=${res1.statusCode}, msg="${res1.message}"`);

  // 2. Prof. Karlito Macadat unlocks terminal
  console.log('\n[2] Prof. Macadat unlocks terminal (892B2E8E):');
  const res2 = await hardwareService.processCardTap('TERM-CL304', '892B2E8E');
  console.log(`Result: code=${res2.code}, section=${res2.data?.sectionCode}, faculty=${res2.data?.facultyName}`);

  // 3. Student 1 taps -> ACCESS GRANTED
  console.log('\n[3] Student 1 taps for attendance (418606B1):');
  const res3 = await hardwareService.processCardTap('TERM-CL304', '418606B1');
  console.log(`Result: code=${res3.code}, student=${res3.data?.studentName}, status=${res3.data?.status}`);

  // 4. Student 1 taps again -> ANTI-PASSBACK
  console.log('\n[4] Student 1 taps again (Anti-passback):');
  const res4 = await hardwareService.processCardTap('TERM-CL304', '418606B1');
  console.log(`Result: code=${res4.code}, status=${res4.statusCode}, msg="${res4.message}"`);

  // 5. Prof. Agbada tries to close Prof. Macadat's session -> NOT_SESSION_OWNER
  console.log('\n[5] Prof. Agbada tries to close Karlito session (71394417):');
  const res5 = await hardwareService.processCardTap('TERM-CL304', '71394417');
  console.log(`Result: code=${res5.code}, status=${res5.statusCode}`);

  // 6. Prof. Macadat closes own session -> SESSION_CLOSED
  console.log('\n[6] Prof. Macadat closes own session (892B2E8E):');
  const res6 = await hardwareService.processCardTap('TERM-CL304', '892B2E8E');
  console.log(`Result: code=${res6.code}, status=${res6.statusCode}, msg="${res6.message}"`);

  // 7. Prof. Agbada opens their own session -> SESSION_STARTED
  console.log('\n[7] Prof. Agbada opens their own session (71394417):');
  const res7 = await hardwareService.processCardTap('TERM-CL304', '71394417');
  console.log(`Result: code=${res7.code}, section=${res7.data?.sectionCode}, faculty=${res7.data?.facultyName}`);

  // Clean up
  await prisma.session.updateMany({
    where: { terminalId: 'TERM-CL304', status: 'OPEN' },
    data: { status: 'CLOSED' }
  });
  console.log('\n✅ Cleaned up sessions.');
}

testFullFlow().catch(console.error).finally(() => prisma.$disconnect());
