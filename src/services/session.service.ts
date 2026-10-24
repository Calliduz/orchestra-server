import { SessionStatus, AttendanceStatus, AuthMethod } from '@prisma/client';
import prisma from '../config/prisma.js';
import { reportService } from './report.service.js';
import { mailerService } from './mailer.service.js';
import {
  emitSessionClosed,
  emitAttendanceUpdated,
  emitPunctualityThresholdUpdated,
} from '../sockets/telemetry.socket.js';

export class SessionService {
  /**
   * Retrieves active session details with real-time roster for a terminal or section
   */
  async getActiveSession(terminalId: string) {
    const session = await prisma.session.findFirst({
      where: {
        terminalId,
        status: SessionStatus.OPEN,
      },
      include: {
        section: true,
        faculty: {
          select: { id: true, firstName: true, lastName: true, email: true, rfidUid: true },
        },
        attendanceLogs: {
          include: {
            student: {
              select: { id: true, studentId: true, firstName: true, lastName: true, email: true, rfidUid: true },
            },
          },
        },
      },
      orderBy: { startTime: 'desc' },
    });

    if (!session) {
      // Find section info assigned to this terminal even if locked
      const section = await prisma.section.findFirst({
        where: { terminalId },
        include: {
          faculty: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          enrollments: {
            include: {
              student: {
                select: { id: true, studentId: true, firstName: true, lastName: true, email: true, rfidUid: true },
              },
            },
            orderBy: { student: { lastName: 'asc' } },
          },
        },
      });

      const roster =
        section?.enrollments.map((enr) => ({
          id: enr.student.id,
          studentNumber: enr.student.studentId || 'N/A',
          firstName: enr.student.firstName,
          lastName: enr.student.lastName,
          fullName: `${enr.student.lastName}, ${enr.student.firstName}`,
          email: enr.student.email,
          rfidUid: enr.student.rfidUid,
          status: AttendanceStatus.ABSENT,
          authMethod: null,
          tapTimestamp: null,
          isManualOverride: false,
          overrideReason: null,
          reverseReceiptSent: false,
        })) || [];

      return {
        isLocked: true,
        status: 'LOCKED',
        terminalId,
        section: section || null,
        session: null,
        roster,
        stats: {
          totalEnrolled: roster.length,
          present: 0,
          late: 0,
          cut: 0,
          absent: roster.length,
          excused: 0,
        },
      };
    }

    // Fetch all enrolled students
    const enrollments = await prisma.enrollment.findMany({
      where: { sectionId: session.sectionId },
      include: {
        student: {
          select: { id: true, studentId: true, firstName: true, lastName: true, email: true, rfidUid: true },
        },
      },
      orderBy: { student: { lastName: 'asc' } },
    });

    const logsMap = new Map(session.attendanceLogs.map((l) => [l.studentId, l]));

    const roster = enrollments.map((enr) => {
      const student = enr.student;
      const log = logsMap.get(student.id);

      return {
        id: student.id,
        studentNumber: student.studentId || 'N/A',
        firstName: student.firstName,
        lastName: student.lastName,
        fullName: `${student.lastName}, ${student.firstName}`,
        email: student.email,
        rfidUid: student.rfidUid,
        status: log ? log.status : AttendanceStatus.ABSENT,
        authMethod: log ? log.authMethod : null,
        tapTimestamp: log ? log.tapTimestamp : null,
        isManualOverride: log ? log.isManualOverride : false,
        overrideReason: log ? log.overrideReason : null,
        reverseReceiptSent: log ? log.reverseReceiptSent : false,
      };
    });

    const stats = this.calculateStats(roster);

    return {
      isLocked: false,
      status: SessionStatus.OPEN,
      terminalId,
      session: {
        id: session.id,
        sectionId: session.sectionId,
        sectionCode: session.section.sectionCode,
        courseName: session.section.courseName,
        roomNumber: session.section.roomNumber,
        facultyName: `Prof. ${session.faculty.firstName} ${session.faculty.lastName}`,
        startTime: session.startTime,
        lateThresholdMins: session.lateThresholdMins,
        cutThresholdMins: session.cutThresholdMins,
      },
      roster,
      stats,
    };
  }

  /**
   * Dynamically adjusts punctuality thresholds and recalculates all non-overridden statuses
   */
  async updatePunctualityThresholds(sessionId: string, lateThresholdMins: number, cutThresholdMins: number) {
    if (lateThresholdMins <= 0 || cutThresholdMins <= lateThresholdMins) {
      throw new Error('Invalid thresholds: Late threshold must be > 0 and Cut threshold must be > Late threshold.');
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        section: true,
        attendanceLogs: true,
      },
    });

    if (!session) {
      throw new Error(`Session ${sessionId} not found.`);
    }

    if (session.status !== SessionStatus.OPEN) {
      throw new Error('Cannot update punctuality thresholds for a closed or cancelled session.');
    }

    // 1. Update session thresholds
    const updatedSession = await prisma.session.update({
      where: { id: sessionId },
      data: {
        lateThresholdMins,
        cutThresholdMins,
      },
    });

    const sessionStartTimeMs = new Date(session.startTime).getTime();

    // 2. Recalculate status for each logged student (unless manually overridden or auto-absent)
    for (const log of session.attendanceLogs) {
      if (log.isManualOverride || !log.tapTimestamp || log.authMethod === AuthMethod.AUTO_ABSENT) {
        continue;
      }

      const elapsedMins = (new Date(log.tapTimestamp).getTime() - sessionStartTimeMs) / (1000 * 60);

      let newStatus: AttendanceStatus = AttendanceStatus.PRESENT;
      if (elapsedMins > cutThresholdMins) {
        newStatus = AttendanceStatus.CUT;
      } else if (elapsedMins > lateThresholdMins) {
        newStatus = AttendanceStatus.LATE;
      }

      if (newStatus !== log.status) {
        await prisma.attendanceLog.update({
          where: { id: log.id },
          data: { status: newStatus },
        });
      }
    }

    // 3. Fetch refreshed roster & stats
    const refreshed = await this.getActiveSession(session.terminalId);

    // 4. Emit Socket.io broadcast
    emitPunctualityThresholdUpdated({
      sessionId: session.id,
      lateThresholdMins,
      cutThresholdMins,
      stats: refreshed.stats,
      roster: refreshed.roster,
    });

    return refreshed;
  }

  /**
   * Faculty manual override for an individual student (Clinic, Excused, ID Misread)
   */
  async applyManualOverride(params: {
    sessionId: string;
    studentId: string;
    status: AttendanceStatus;
    reason: string;
    facultyId?: string;
  }) {
    const session = await prisma.session.findUnique({
      where: { id: params.sessionId },
      include: { section: true },
    });

    if (!session) {
      throw new Error(`Session ${params.sessionId} not found.`);
    }

    // Verify student exists
    const student = await prisma.user.findFirst({
      where: {
        OR: [{ id: params.studentId }, { studentId: params.studentId }],
      },
    });

    if (!student) {
      throw new Error(`Student with identifier ${params.studentId} not found.`);
    }

    // Upsert attendance log for student
    const existingLog = await prisma.attendanceLog.findUnique({
      where: {
        sessionId_studentId: {
          sessionId: params.sessionId,
          studentId: student.id,
        },
      },
    });

    let updatedLog;
    if (existingLog) {
      updatedLog = await prisma.attendanceLog.update({
        where: { id: existingLog.id },
        data: {
          status: params.status,
          isManualOverride: true,
          overrideReason: params.reason,
          overriddenById: params.facultyId || null,
          overriddenAt: new Date(),
          tapTimestamp: existingLog.tapTimestamp || new Date(),
          authMethod: existingLog.authMethod === AuthMethod.AUTO_ABSENT ? AuthMethod.MANUAL_OVERRIDE : existingLog.authMethod,
        },
        include: { student: true },
      });
    } else {
      updatedLog = await prisma.attendanceLog.create({
        data: {
          sessionId: params.sessionId,
          studentId: student.id,
          status: params.status,
          authMethod: AuthMethod.MANUAL_OVERRIDE,
          tapTimestamp: new Date(),
          isManualOverride: true,
          overrideReason: params.reason,
          overriddenById: params.facultyId || null,
          overriddenAt: new Date(),
        },
        include: { student: true },
      });
    }

    // Refetch refreshed roster and stats
    const refreshed = await this.getActiveSession(session.terminalId);

    // Emit Socket.io telemetry update
    emitAttendanceUpdated({
      sessionId: session.id,
      terminalId: session.terminalId,
      studentId: student.id,
      studentNumber: student.studentId || 'N/A',
      studentName: `${student.firstName} ${student.lastName}`,
      status: updatedLog.status,
      authMethod: updatedLog.authMethod,
      tapTimestamp: updatedLog.tapTimestamp ? updatedLog.tapTimestamp.toISOString() : null,
      isManualOverride: true,
      overrideReason: params.reason,
      stats: refreshed.stats,
      roster: refreshed.roster,
    });

    return {
      log: updatedLog,
      stats: refreshed.stats,
      roster: refreshed.roster,
    };
  }

  /**
   * Finalizes class session, marks absent students, generates reports and emails faculty
   */
  async closeSession(sessionId: string) {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        section: true,
        faculty: true,
      },
    });

    if (!session) {
      throw new Error(`Session ${sessionId} not found.`);
    }

    if (session.status !== SessionStatus.OPEN) {
      throw new Error('Session is not currently open.');
    }

    // 1. Mark session as CLOSED
    const now = new Date();
    await prisma.session.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.CLOSED,
        endTime: now,
      },
    });

    // 2. Auto-mark absent: Find all enrolled students without logs
    const enrollments = await prisma.enrollment.findMany({
      where: { sectionId: session.sectionId },
    });

    const existingLogs = await prisma.attendanceLog.findMany({
      where: { sessionId },
      select: { studentId: true },
    });
    const loggedStudentIds = new Set(existingLogs.map((l) => l.studentId));

    const absentStudents = enrollments.filter((e) => !loggedStudentIds.has(e.studentId));

    for (const enr of absentStudents) {
      await prisma.attendanceLog.create({
        data: {
          sessionId,
          studentId: enr.studentId,
          status: AttendanceStatus.ABSENT,
          authMethod: AuthMethod.AUTO_ABSENT,
          tapTimestamp: null,
          isManualOverride: false,
          overrideReason: 'Unlogged at Session Close',
        },
      });
    }

    // 3. Generate PDF and CSV Master Reports
    const { pdfPath, csvPath } = await reportService.generateSessionReports(sessionId);

    // 4. Calculate final stats & roster
    const finalSession = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        attendanceLogs: {
          include: { student: true },
        },
      },
    });

    const finalRoster = enrollments.map((enr) => {
      const log = finalSession?.attendanceLogs.find((l) => l.studentId === enr.studentId);
      return {
        studentId: enr.studentId,
        status: log?.status || AttendanceStatus.ABSENT,
      };
    });

    const finalStats = this.calculateStats(finalRoster);

    // 5. Send automated report to faculty via Nodemailer
    await mailerService.sendFacultySessionReport({
      facultyEmail: session.faculty.email,
      facultyName: `${session.faculty.firstName} ${session.faculty.lastName}`,
      sectionCode: session.section.sectionCode,
      courseName: session.section.courseName,
      pdfPath,
      csvPath,
      stats: finalStats,
    });

    // Update reportSentAt
    await prisma.session.update({
      where: { id: sessionId },
      data: { reportSentAt: new Date() },
    });

    // 6. Broadcast Socket.io session:closed event
    emitSessionClosed({
      sessionId,
      terminalId: session.terminalId,
      sectionCode: session.section.sectionCode,
      courseName: session.section.courseName,
      endTime: now.toISOString(),
      stats: finalStats,
      roster: finalRoster,
    });

    return {
      success: true,
      sessionId,
      stats: finalStats,
      pdfPath,
      csvPath,
    };
  }

  /**
   * Helper to tally statistics
   */
  private calculateStats(roster: { status: string }[]) {
    const totalEnrolled = roster.length;
    const present = roster.filter((r) => r.status === 'PRESENT').length;
    const late = roster.filter((r) => r.status === 'LATE').length;
    const cut = roster.filter((r) => r.status === 'CUT').length;
    const excused = roster.filter((r) => r.status === 'EXCUSED').length;
    const absent = roster.filter((r) => r.status === 'ABSENT').length;

    return {
      totalEnrolled,
      present,
      late,
      cut,
      excused,
      absent,
    };
  }
}

export const sessionService = new SessionService();
export default sessionService;
