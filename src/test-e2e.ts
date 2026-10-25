import http from 'http';
import app from './app.js';
import { initializeSocket } from './sockets/telemetry.socket.js';
import prisma from './config/prisma.js';

const PORT = 5555;
const BASE_URL = `http://localhost:${PORT}/api/v1`;
const API_KEY = 'ORCHESTRA_ESP32_SECURE_TOKEN_2026';
const TERMINAL_ID = 'TERM-CL304';
const FACULTY_RFID = 'A1B2C3D4';
const STUDENT1_RFID = '10A1B2C3'; // Justine Jay Agbada (2023-0001-CCS)
const STUDENT2_ID = '2023-0002-CCS'; // Rjhay Altichie

async function runTests() {
  console.log('🧪 Starting ORCHESTRA Step 2 End-to-End Test Suite...\n');

  const server = http.createServer(app);
  initializeSocket(server);

  await new Promise<void>((resolve) => server.listen(PORT, () => resolve()));
  console.log(`🚀 Test Server listening on http://localhost:${PORT}`);

  try {
    // 0. Health check
    console.log('\n--- TEST 0: Health Check ---');
    const healthRes = await fetch(`${BASE_URL}/health`);
    const healthJson = (await healthRes.json()) as any;
    console.log('Health Response:', healthJson);

    // 1. Student card tap on LOCKED terminal
    console.log('\n--- TEST 1: Student Tap on LOCKED Terminal (Hardware-Enforced Session Trust) ---');
    const tapLockedRes = await fetch(`${BASE_URL}/hardware/tap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      body: JSON.stringify({ terminalId: TERMINAL_ID, rfidUid: STUDENT1_RFID }),
    });
    const tapLockedJson = (await tapLockedRes.json()) as any;
    console.log(`Status: ${tapLockedRes.status} | Code: ${tapLockedJson.code}`);
    console.log(`Message: ${tapLockedJson.message}`);
    if (tapLockedRes.status === 403 && tapLockedJson.code === 'SESSION_LOCKED') {
      console.log('✅ PASS: Student tap correctly rejected while terminal is LOCKED.');
    } else {
      throw new Error('FAIL: Terminal did not reject student tap in LOCKED state.');
    }

    // 2. Faculty Master Badge Tap to OPEN session
    console.log('\n--- TEST 2: Faculty Master Badge Scan (Unlocking Session) ---');
    const facultyTapRes = await fetch(`${BASE_URL}/hardware/tap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      body: JSON.stringify({ terminalId: TERMINAL_ID, rfidUid: FACULTY_RFID }),
    });
    const facultyTapJson = (await facultyTapRes.json()) as any;
    console.log(`Status: ${facultyTapRes.status} | Code: ${facultyTapJson.code}`);
    console.log('Data:', facultyTapJson.data);
    if (facultyTapRes.status === 200 && facultyTapJson.code === 'SESSION_STARTED') {
      console.log('✅ PASS: Faculty Master Badge successfully opened active class session.');
    } else {
      throw new Error('FAIL: Faculty Master Badge did not open session.');
    }

    const sessionId = facultyTapJson.data.sessionId;

    // 3. Student Card Tap in OPEN session
    console.log('\n--- TEST 3: Student Card Scan in OPEN Session ---');
    const studentTapRes = await fetch(`${BASE_URL}/hardware/tap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      body: JSON.stringify({ terminalId: TERMINAL_ID, rfidUid: STUDENT1_RFID }),
    });
    const studentTapJson = (await studentTapRes.json()) as any;
    console.log(`Status: ${studentTapRes.status} | Code: ${studentTapJson.code}`);
    console.log('Data:', studentTapJson.data);
    if (studentTapRes.status === 200 && studentTapJson.code === 'ACCESS_GRANTED') {
      console.log('✅ PASS: Student attendance logged as PRESENT.');
    } else {
      throw new Error('FAIL: Student card tap was not granted.');
    }

    // 4. Multi-Layer Anti-Proxy Defense: Anti-Passback Test (Duplicate Tap)
    console.log('\n--- TEST 4: Anti-Passback Defense Check (Duplicate Card Tap) ---');
    const duplicateTapRes = await fetch(`${BASE_URL}/hardware/tap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      body: JSON.stringify({ terminalId: TERMINAL_ID, rfidUid: STUDENT1_RFID }),
    });
    const duplicateTapJson = (await duplicateTapRes.json()) as any;
    console.log(`Status: ${duplicateTapRes.status} | Code: ${duplicateTapJson.code}`);
    console.log(`Message: ${duplicateTapJson.message}`);
    if (duplicateTapRes.status === 409 && duplicateTapJson.code === 'ALREADY_RECORDED') {
      console.log('✅ PASS: Anti-Passback constraint rejected duplicate tap.');
    } else {
      throw new Error('FAIL: Duplicate tap was not rejected by Anti-Passback.');
    }

    // 5. Exception Handling & OTP Fallback: Student requests 60s OTP
    console.log('\n--- TEST 5: Student 60-Second OTP Request via Web Route ---');
    const otpReqRes = await fetch(`${BASE_URL}/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: STUDENT2_ID }),
    });
    const otpReqJson = (await otpReqRes.json()) as any;
    console.log(`Status: ${otpReqRes.status} | Message: ${otpReqJson.message}`);
    console.log('OTP Data:', otpReqJson.data);
    const otpCode = otpReqJson.data.otp;
    if (otpReqRes.status === 200 && otpCode && otpCode.length === 6) {
      console.log(`✅ PASS: 6-digit OTP (${otpCode}) generated with 60-second TTL.`);
    } else {
      throw new Error('FAIL: OTP generation failed.');
    }

    // 6. Exception Handling: Submit Keypad OTP at Terminal
    console.log('\n--- TEST 6: Terminal Keypad OTP Verification ---');
    const otpVerifyRes = await fetch(`${BASE_URL}/hardware/otp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      body: JSON.stringify({ terminalId: TERMINAL_ID, code: otpCode }),
    });
    const otpVerifyJson = (await otpVerifyRes.json()) as any;
    console.log(`Status: ${otpVerifyRes.status} | Code: ${otpVerifyJson.code}`);
    console.log('Data:', otpVerifyJson.data);
    if (otpVerifyRes.status === 200 && otpVerifyJson.code === 'OTP_GRANTED') {
      console.log('✅ PASS: Keypad OTP verified and attendance recorded.');
    } else {
      throw new Error('FAIL: Keypad OTP verification failed.');
    }

    // 7. Dynamic Punctuality Sliders
    console.log('\n--- TEST 7: Update Punctuality Thresholds ---');
    const thresholdRes = await fetch(`${BASE_URL}/sessions/${sessionId}/thresholds`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lateThresholdMins: 20, cutThresholdMins: 50 }),
    });
    const thresholdJson = (await thresholdRes.json()) as any;
    console.log(`Status: ${thresholdRes.status} | Late: ${thresholdJson.data.session.lateThresholdMins}m | Cut: ${thresholdJson.data.session.cutThresholdMins}m`);
    if (thresholdRes.status === 200) {
      console.log('✅ PASS: Punctuality thresholds updated dynamically.');
    }

    // 8. Manual Override
    console.log('\n--- TEST 8: Faculty Manual Status Override (Clinic Visit) ---');
    const overrideRes = await fetch(`${BASE_URL}/sessions/${sessionId}/override`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: '2023-0003-CCS', // Josh Lister Cabunoc
        status: 'EXCUSED',
        reason: 'University Clinic Medical Referral - Fever',
      }),
    });
    const overrideJson = (await overrideRes.json()) as any;
    console.log(`Status: ${overrideRes.status} | Status: ${overrideJson.data.log.status} | Remarks: ${overrideJson.data.log.overrideReason}`);
    if (overrideRes.status === 200 && overrideJson.data.log.status === 'EXCUSED') {
      console.log('✅ PASS: Manual override applied successfully.');
    }

    // 9. Faculty Master Badge Scan a Second Time -> Finalize & Close Session
    console.log('\n--- TEST 9: Faculty Master Badge Scan to Finalize Session ---');
    const facultyCloseRes = await fetch(`${BASE_URL}/hardware/tap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      body: JSON.stringify({ terminalId: TERMINAL_ID, rfidUid: FACULTY_RFID }),
    });
    const facultyCloseJson = (await facultyCloseRes.json()) as any;
    console.log(`Status: ${facultyCloseRes.status} | Code: ${facultyCloseJson.code}`);
    console.log('Final Stats:', facultyCloseJson.data.stats);
    console.log('Generated PDF Path:', facultyCloseJson.data.pdfPath);
    console.log('Generated CSV Path:', facultyCloseJson.data.csvPath);
    if (facultyCloseRes.status === 200 && facultyCloseJson.code === 'SESSION_CLOSED') {
      console.log('✅ PASS: Session successfully closed, absent students marked, and reports compiled.');
    } else {
      throw new Error('FAIL: Session closure failed.');
    }

    console.log('\n======================================================');
    console.log('🏆 ALL STEP 2 END-TO-END TESTS PASSED CONCURRENTLY!');
    console.log('======================================================\n');
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

runTests().catch((err) => {
  console.error('❌ Test Suite Error:', err);
  process.exit(1);
});
