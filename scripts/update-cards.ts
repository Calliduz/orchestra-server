import prisma from '../src/config/prisma.js';

async function updateCards() {
  const updates = [
    { studentId: 'FAC-2026-001', rfidUid: '892B2E8E', label: 'Faculty 1 - Prof. Karlito Macadat' },
    { studentId: 'FAC-2026-002', rfidUid: '71394417', label: 'Faculty 2 - Prof. Justine Jay Agbada' },
    { studentId: '2023-0004-CCS', rfidUid: '418606B1', label: 'Student 1 - Juztyne Clever Dalupang' },
    { studentId: '2023-0001-CCS', rfidUid: '91C6F3B0', label: 'Student 2 - Justine Jay Agbada' },
    { studentId: '2023-0002-CCS', rfidUid: 'B173F9B0', label: 'Student 3 - Rjhay Altichie' },
    { studentId: '2023-0003-CCS', rfidUid: '119255B1', label: 'Student 4 - Josh Lister Cabunoc' },
  ];

  console.log('🔄 Updating physical RFID cards in Neon database...');
  for (const item of updates) {
    const res = await prisma.user.update({
      where: { studentId: item.studentId },
      data: { rfidUid: item.rfidUid }
    });
    console.log(`✅ [${res.role}] ${item.label} (ID: ${res.studentId}) -> RFID UID: ${res.rfidUid}`);
  }
  console.log('✨ All 6 cards registered successfully!');
}

updateCards()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });

