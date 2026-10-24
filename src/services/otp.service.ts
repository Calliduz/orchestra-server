import crypto from 'crypto';
import { SessionStatus, AttendanceStatus, AuthMethod } from '@prisma/client';
import prisma from '../config/prisma.js';
import { sessionService } from './session.service.js';
import { mailerService } from './mailer.service.js';
import { emitAttendanceUpdated } from '../sockets/telemetry.socket.js';

export interface OtpVerificationResult {
  statusCode: number;
  success: boolean;
  code: 'OTP_GRANTED' | 'INVALID_OTP' | 'SESSION_LOCKED' | 'ALREADY_RECORDED' | 'ERROR';
  message: string;
  data?: any;
}

export class OtpService {
  /**
   * Generates a 60-second time-decaying 6-digit OTP for a student who forgot their badge
   */
  async requestStudentOtp(identifier: string) {
    const cleanId = identifier.trim();

    // 1. Locate student
    const student = await prisma.user.findFirst({
      where: {
        OR: [{ studentId: cleanId }, { email: cleanId }],
      },
      include: {
        enrollments: {
          select: { sectionId: true },
        },
      },
    });

    if (!student) {
      throw new Error(`Student record not found for "${identifier}".`);
    }

    const enrolledSectionIds = student.enrollments.map((e) => e.sectionId);
    if (enrolledSectionIds.length === 0) {
      throw new Error('You are not enrolled in any registered course sections.');
    }

    // 2. Locate active session for student's enrolled courses
    const activeSession = await prisma.session.findFirst({
      where: {
        sectionId: { in: enrolledSectionIds },
        status: SessionStatus.OPEN,
      },
      include: {
        section: true,
        faculty: true,
      },
      orderBy: { startTime: 'desc' },
    });

    if (!activeSession) {
      throw new Error('No active class session is currently open for your enrolled courses.');
    }

    // 3. Anti-Passback Check: has this student already checked in?
    const existingLog = await prisma.attendanceLog.findUnique({
      where: {
        sessionId_studentId: {
          sessionId: activeSession.id,
          studentId: student.id,
        },
      },
    });

    if (existingLog && existingLog.authMethod !== AuthMethod.AUTO_ABSENT) {
      throw new Error(`You have already checked in for this session (${existingLog.status} at ${existingLog.tapTimestamp?.toLocaleTimeString()}).`);
    }

    // 4. Invalidate any existing unused OTPs for this student & session
    await prisma.otpCode.updateMany({
      where: {
        studentId: student.id,
        sessionId: activeSession.id,
        isUsed: false,
      },
      data: { isUsed: true },
    });

    // 5. Generate 6-digit numeric PIN
    const otpCode = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + 60 * 1000); // 60 seconds TTL

    await prisma.otpCode.create({
      data: {
        studentId: student.id,
        sessionId: activeSession.id,
        code: otpCode,
        expiresAt,
        isUsed: false,
      },
    });

    return {
      otp: otpCode,
      expiresAt: expiresAt.toISOString(),
      expiresInSeconds: 60,
      studentId: student.studentId,
      studentName: `${student.firstName} ${student.lastName}`,
      sectionCode: activeSession.section.sectionCode,
      courseName: activeSession.section.courseName,
      roomNumber: activeSession.section.roomNumber,
      terminalId: activeSession.terminalId,
    };
  }

  /**
   * Verifies keypad OTP submitted from ESP32 4x4 matrix keypad
   */
  async verifyKeypadOtp(terminalId: string, rawCode: string): Promise<OtpVerificationResult> {
    const code = rawCode.trim();

    if (!/^\d{6}$/.test(code)) {
      return {
        statusCode: 400,
        success: false,
        code: 'INVALID_OTP',
        message: 'Invalid PIN: OTP must be exactly 6 digits.',
      };
    }

    // 1. Verify terminal has an active session
    const activeSession = await prisma.session.findFirst({
      where: {
        terminalId,
        status: SessionStatus.OPEN,
      },
      include: {
        section: true,
      },
    });

    if (!activeSession) {
      return {
        statusCode: 403,
        success: false,
        code: 'SESSION_LOCKED',
        message: 'TERMINAL LOCKED: No active session. Waiting for faculty master badge.',
      };
    }

    const now = new Date();

    // 2. Query valid unexpired, unused OTP for this session
    const otpRecord = await prisma.otpCode.findFirst({
      where: {
        sessionId: activeSession.id,
        code,
        isUsed: false,
        expiresAt: { gt: now },
      },
      include: {
        student: true,
      },
    });

    if (!otpRecord) {
      return {
        statusCode: 400,
        success: false,
        code: 'INVALID_OTP',
        message: 'INVALID OR EXPIRED OTP: Code has expired or does not match this session.',
      };
    }

    // 3. Mark OTP as used
    await prisma.otpCode.update({
      where: { id: otpRecord.id },
      data: {
        isUsed: true,
        usedAt: now,
      },
    });

    const student = otpRecord.student;

    // 4. Anti-passback check
    const existingLog = await prisma.attendanceLog.findUnique({
      where: {
        sessionId_studentId: {
          sessionId: activeSession.id,
          studentId: student.id,
        },
      },
    });

    if (existingLog && existingLog.authMethod !== AuthMethod.AUTO_ABSENT) {
      return {
        statusCode: 409,
        success: false,
        code: 'ALREADY_RECORDED',
        message: `ANTI-PASSBACK ALERT: ${student.firstName} ${student.lastName} is already checked in.`,
      };
    }

    // 5. Punctuality calculation
    const elapsedMins = (now.getTime() - new Date(activeSession.startTime).getTime()) / (1000 * 60);

    let status: AttendanceStatus = AttendanceStatus.PRESENT;
    if (elapsedMins > activeSession.cutThresholdMins) {
      status = AttendanceStatus.CUT;
    } else if (elapsedMins > activeSession.lateThresholdMins) {
      status = AttendanceStatus.LATE;
    }

    // 6. Record attendance log
    let attendanceLog;
    if (existingLog) {
      attendanceLog = await prisma.attendanceLog.update({
        where: { id: existingLog.id },
        data: {
          status,
          authMethod: AuthMethod.KEYPAD_OTP,
          tapTimestamp: now,
          reverseReceiptSent: false,
        },
      });
    } else {
      attendanceLog = await prisma.attendanceLog.create({
        data: {
          sessionId: activeSession.id,
          studentId: student.id,
          status,
          authMethod: AuthMethod.KEYPAD_OTP,
          tapTimestamp: now,
          reverseReceiptSent: false,
        },
      });
    }

    // 7. Asynchronous Reverse-Receipt Notification
    mailerService
      .sendReverseReceipt({
        logId: attendanceLog.id,
        studentEmail: student.email,
        studentName: `${student.firstName} ${student.lastName}`,
        sectionCode: activeSession.section.sectionCode,
        courseName: activeSession.section.courseName,
        roomNumber: activeSession.section.roomNumber,
        tapTime: now,
        authMethod: 'Keypad 6-Digit OTP Fallback',
      })
      .catch((err) => console.error('Reverse-receipt async dispatch error:', err));

    // 8. Broadcast telemetry update to Faculty Dashboard
    const activeDetails = await sessionService.getActiveSession(terminalId);

    emitAttendanceUpdated({
      sessionId: activeSession.id,
      terminalId,
      studentId: student.id,
      studentNumber: student.studentId || 'N/A',
      studentName: `${student.firstName} ${student.lastName}`,
      status,
      authMethod: AuthMethod.KEYPAD_OTP,
      tapTimestamp: now.toISOString(),
      isManualOverride: false,
      stats: activeDetails.stats,
      roster: activeDetails.roster,
    });

    return {
      statusCode: 200,
      success: true,
      code: 'OTP_GRANTED',
      message: `OTP VERIFIED: Welcome ${student.firstName} ${student.lastName} [${status}]`,
      data: {
        studentId: student.studentId,
        studentName: `${student.firstName} ${student.lastName}`,
        status,
        tapTime: now.toISOString(),
      },
    };
  }
}

export const otpService = new OtpService();
export default otpService;
