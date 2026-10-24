import { SessionStatus, AttendanceStatus, AuthMethod, Role } from '@prisma/client';
import prisma from '../config/prisma.js';
import { sessionService } from './session.service.js';
import { mailerService } from './mailer.service.js';
import { emitSessionStarted, emitAttendanceUpdated } from '../sockets/telemetry.socket.js';

export interface HardwareTapResult {
  statusCode: number;
  success: boolean;
  code: 'SESSION_STARTED' | 'SESSION_CLOSED' | 'ACCESS_GRANTED' | 'SESSION_LOCKED' | 'NOT_ENROLLED' | 'ALREADY_RECORDED' | 'UNREGISTERED_CARD' | 'ERROR';
  message: string;
  data?: any;
}

export class HardwareService {
  /**
   * Normalizes raw RFID UID strings from hardware (removes spaces, colons, lower-case)
   */
  normalizeRfid(rfid: string): string {
    return rfid.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  }

  /**
   * Evaluates hardware RFID card tap against the Hardware-Enforced Session Trust model
   */
  async processCardTap(terminalId: string, rawRfidUid: string): Promise<HardwareTapResult> {
    const cleanRfid = this.normalizeRfid(rawRfidUid);

    // 1. Identify active session for this terminal
    const activeSession = await prisma.session.findFirst({
      where: {
        terminalId,
        status: SessionStatus.OPEN,
      },
      include: {
        section: true,
        faculty: true,
      },
    });

    // 2. Identify user by RFID UID
    const cardHolder = await prisma.user.findUnique({
      where: { rfidUid: cleanRfid },
    });

    const now = new Date();

    // -----------------------------------------------------------------
    // CASE 1: TERMINAL IS IN LOCKED STATE (No Active Session)
    // -----------------------------------------------------------------
    if (!activeSession) {
      if (!cardHolder) {
        return {
          statusCode: 403,
          success: false,
          code: 'SESSION_LOCKED',
          message: 'Terminal locked. Unregistered badge scanned.',
        };
      }

      // If a student tries to scan while terminal is locked -> REJECT (403 SESSION_LOCKED)
      if (cardHolder.role === Role.STUDENT) {
        return {
          statusCode: 403,
          success: false,
          code: 'SESSION_LOCKED',
          message: 'TERMINAL LOCKED: Waiting for Faculty Master Badge to initiate session.',
        };
      }

      // If Faculty or Admin scans master badge -> UNLOCK TERMINAL & OPEN SESSION
      const section = await prisma.section.findFirst({
        where: { terminalId },
        include: { faculty: true },
      });

      if (!section) {
        return {
          statusCode: 404,
          success: false,
          code: 'ERROR',
          message: `No course section configured for Terminal ID ${terminalId}.`,
        };
      }

      const newSession = await prisma.session.create({
        data: {
          sectionId: section.id,
          facultyId: cardHolder.id,
          terminalId,
          status: SessionStatus.OPEN,
          startTime: now,
          lateThresholdMins: section.defaultLateThresholdMins,
          cutThresholdMins: section.defaultCutThresholdMins,
        },
        include: {
          section: true,
          faculty: true,
        },
      });

      // Fetch enrolled roster
      const activeDetails = await sessionService.getActiveSession(terminalId);

      // Broadcast session:started telemetry to React dashboards
      emitSessionStarted({
        sessionId: newSession.id,
        terminalId,
        sectionCode: section.sectionCode,
        courseName: section.courseName,
        roomNumber: section.roomNumber,
        facultyName: `Prof. ${cardHolder.firstName} ${cardHolder.lastName}`,
        startTime: now.toISOString(),
        lateThresholdMins: newSession.lateThresholdMins,
        cutThresholdMins: newSession.cutThresholdMins,
        totalEnrolled: activeDetails.stats.totalEnrolled,
        roster: activeDetails.roster,
      });

      return {
        statusCode: 200,
        success: true,
        code: 'SESSION_STARTED',
        message: `SESSION OPENED: ${section.sectionCode} (${section.roomNumber})`,
        data: {
          sessionId: newSession.id,
          sectionCode: section.sectionCode,
          courseName: section.courseName,
          facultyName: `${cardHolder.firstName} ${cardHolder.lastName}`,
          startTime: now.toISOString(),
          lateThresholdMins: newSession.lateThresholdMins,
          cutThresholdMins: newSession.cutThresholdMins,
        },
      };
    }

    // -----------------------------------------------------------------
    // CASE 2: TERMINAL IS IN ACTIVE (OPEN) STATE
    // -----------------------------------------------------------------

    // If cardHolder not found in database
    if (!cardHolder) {
      return {
        statusCode: 404,
        success: false,
        code: 'UNREGISTERED_CARD',
        message: 'Unregistered RFID card. Please register at student portal.',
      };
    }

    // SUB-CASE 2A: Faculty Master Badge scanned a second time -> CLOSE SESSION
    if (cardHolder.role === Role.FACULTY || cardHolder.role === Role.ADMIN) {
      const closeResult = await sessionService.closeSession(activeSession.id);

      return {
        statusCode: 200,
        success: true,
        code: 'SESSION_CLOSED',
        message: `SESSION CLOSED: Roster compiled & emailed for ${activeSession.section.sectionCode}.`,
        data: closeResult,
      };
    }

    // SUB-CASE 2B: Student Card Scanned -> Process Attendance Check-In
    // 1. Verify Enrollment in this Section
    const enrollment = await prisma.enrollment.findUnique({
      where: {
        studentId_sectionId: {
          studentId: cardHolder.id,
          sectionId: activeSession.sectionId,
        },
      },
    });

    if (!enrollment) {
      return {
        statusCode: 403,
        success: false,
        code: 'NOT_ENROLLED',
        message: `ACCESS DENIED: ${cardHolder.firstName} ${cardHolder.lastName} is not enrolled in ${activeSession.section.sectionCode}.`,
      };
    }

    // 2. Anti-Passback Defense Check
    const existingLog = await prisma.attendanceLog.findUnique({
      where: {
        sessionId_studentId: {
          sessionId: activeSession.id,
          studentId: cardHolder.id,
        },
      },
    });

    if (existingLog && existingLog.authMethod !== AuthMethod.AUTO_ABSENT) {
      return {
        statusCode: 409,
        success: false,
        code: 'ALREADY_RECORDED',
        message: `ANTI-PASSBACK ALERT: ${cardHolder.firstName} ${cardHolder.lastName} is already checked in.`,
        data: {
          studentId: cardHolder.studentId,
          studentName: `${cardHolder.firstName} ${cardHolder.lastName}`,
          status: existingLog.status,
          tapTime: existingLog.tapTimestamp,
        },
      };
    }

    // 3. Punctuality Evaluation
    const elapsedMins = (now.getTime() - new Date(activeSession.startTime).getTime()) / (1000 * 60);

    let status: AttendanceStatus = AttendanceStatus.PRESENT;
    if (elapsedMins > activeSession.cutThresholdMins) {
      status = AttendanceStatus.CUT;
    } else if (elapsedMins > activeSession.lateThresholdMins) {
      status = AttendanceStatus.LATE;
    }

    // 4. Create or Update Attendance Record
    let attendanceLog;
    if (existingLog) {
      attendanceLog = await prisma.attendanceLog.update({
        where: { id: existingLog.id },
        data: {
          status,
          authMethod: AuthMethod.RFID_TAP,
          tapTimestamp: now,
          reverseReceiptSent: false,
        },
      });
    } else {
      attendanceLog = await prisma.attendanceLog.create({
        data: {
          sessionId: activeSession.id,
          studentId: cardHolder.id,
          status,
          authMethod: AuthMethod.RFID_TAP,
          tapTimestamp: now,
          reverseReceiptSent: false,
        },
      });
    }

    // 5. Asynchronous Multi-Layer Anti-Proxy Defense: Automated Reverse-Receipt Notification
    mailerService
      .sendReverseReceipt({
        logId: attendanceLog.id,
        studentEmail: cardHolder.email,
        studentName: `${cardHolder.firstName} ${cardHolder.lastName}`,
        sectionCode: activeSession.section.sectionCode,
        courseName: activeSession.section.courseName,
        roomNumber: activeSession.section.roomNumber,
        tapTime: now,
        authMethod: 'RFID Tap (13.56MHz Contactless)',
      })
      .catch((err) => console.error('Reverse-receipt async dispatch error:', err));

    // 6. Broadcast Real-Time Telemetry to Faculty Dashboard
    const activeDetails = await sessionService.getActiveSession(terminalId);

    emitAttendanceUpdated({
      sessionId: activeSession.id,
      terminalId,
      studentId: cardHolder.id,
      studentNumber: cardHolder.studentId || 'N/A',
      studentName: `${cardHolder.firstName} ${cardHolder.lastName}`,
      status,
      authMethod: AuthMethod.RFID_TAP,
      tapTimestamp: now.toISOString(),
      isManualOverride: false,
      stats: activeDetails.stats,
      roster: activeDetails.roster,
    });

    return {
      statusCode: 200,
      success: true,
      code: 'ACCESS_GRANTED',
      message: `GRANTED: ${cardHolder.firstName} ${cardHolder.lastName} [${status}]`,
      data: {
        studentId: cardHolder.studentId,
        studentName: `${cardHolder.firstName} ${cardHolder.lastName}`,
        status,
        tapTime: now.toISOString(),
        elapsedMins: Math.round(elapsedMins),
      },
    };
  }
}

export const hardwareService = new HardwareService();
export default hardwareService;
