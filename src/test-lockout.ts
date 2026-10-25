import http from 'http';
import app from './app.js';
import { initializeSocket } from './sockets/telemetry.socket.js';
import prisma from './config/prisma.js';

const PORT = 5556;
const BASE_URL = `http://localhost:${PORT}/api/v1`;
const API_KEY = 'ORCHESTRA_ESP32_SECURE_TOKEN_2026';
const TERMINAL_ID = 'TERM-CL304';
const FACULTY_RFID = 'A1B2C3D4';
const STUDENT_ID = '2023-0004-CCS'; // Juztyne Clever Dalupang

async function testLockout() {
  console.log('🧪 Testing 3-Strike OTP Lockout Defense...');

  const server = http.createServer(app);
  initializeSocket(server);
  await new Promise<void>((res) => server.listen(PORT, () => res()));

  try {
    // 1. Open session if not open
    const openRes = await fetch(`${BASE_URL}/hardware/tap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ terminalId: TERMINAL_ID, rfidUid: FACULTY_RFID }),
    });
    const openJson = (await openRes.json()) as any;
    console.log('Session status:', openJson.code);

    // 2. Request OTP
    const otpRes = await fetch(`${BASE_URL}/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: STUDENT_ID }),
    });
    const otpJson = (await otpRes.json()) as any;
    console.log('Generated OTP:', otpJson.data.otp);

    // 3. Attempt 1 with wrong code
    const att1 = await fetch(`${BASE_URL}/hardware/otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ terminalId: TERMINAL_ID, code: '000000' }),
    });
    const att1Json = (await att1.json()) as any;
    console.log(`Attempt 1 -> Status: ${att1.status} | Code: ${att1Json.code} | Message: ${att1Json.message}`);
    if (att1.status !== 400 || !att1Json.message.includes('Attempt 1 of 3')) {
      throw new Error('Attempt 1 did not register correctly');
    }

    // 4. Attempt 2 with wrong code
    const att2 = await fetch(`${BASE_URL}/hardware/otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ terminalId: TERMINAL_ID, code: '111111' }),
    });
    const att2Json = (await att2.json()) as any;
    console.log(`Attempt 2 -> Status: ${att2.status} | Code: ${att2Json.code} | Message: ${att2Json.message}`);
    if (att2.status !== 400 || !att2Json.message.includes('Attempt 2 of 3')) {
      throw new Error('Attempt 2 did not register correctly');
    }

    // 5. Attempt 3 with wrong code (Lockout trigger)
    const att3 = await fetch(`${BASE_URL}/hardware/otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ terminalId: TERMINAL_ID, code: '222222' }),
    });
    const att3Json = (await att3.json()) as any;
    console.log(`Attempt 3 -> Status: ${att3.status} | Code: ${att3Json.code} | Message: ${att3Json.message}`);
    if (att3.status !== 403 || att3Json.code !== 'LOCKED_OUT') {
      throw new Error('Attempt 3 did not trigger LOCKED_OUT');
    }

    console.log('\n🔒 3-STRIKE LOCKOUT DEFENSE CONFIRMED & VERIFIED!\n');
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

testLockout().catch((e) => {
  console.error('Lockout test failed:', e);
  process.exit(1);
});
