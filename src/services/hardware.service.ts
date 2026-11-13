import { SessionStatus, AttendanceStatus, AuthMethod, Role } from '@prisma/client';
import prisma from '../config/prisma.js';
import { sessionService } from './session.service.js';
import { mailerService } from './mailer.service.js';
import { emitSessionStarted, emitAttendanceUpdated, emitCardScanned, emitEnrollmentModeChanged } from '../sockets/telemetry.socket.js';

export interface HardwareTapResult {
  statusCode: number;
  success: boolean;
  code:
    | 'SESSION_STARTED'
    | 'SESSION_CLOSED'
    | 'ACCESS_GRANTED'
    | 'SESSION_LOCKED'
    | 'NOT_ENROLLED'
    | 'NOT_SESSION_OWNER'
    | 'UNAUTHORIZED_FACULTY'
    | 'ALREADY_RECORDED'
    | 'UNREGISTERED_CARD'
    | 'ENROLLMENT_CAPTURED'
    | 'FACULTY_BADGE_REQUIRED'
    | 'ERROR';
  message: string;
  data?: any;
}

export interface EnrollmentSession {
  terminalId: string;
  targetRole: 'STUDENT' | 'FACULTY' | 'ADMIN';
  targetName?: string;
  startedAt: string;
}

export class HardwareService {
  private lastScannedCard: {
    rfidUid: string;
    terminalId: string;
    timestamp: string;
    isRegistered: boolean;
    cardHolder: any;
  } | null = null;

  private activeEnrollment: EnrollmentSession | null = null;

  // Interlock tracker: Prevents rapid re-opening if terminal was recently closed
  private terminalLastClosed = new Map<string, number>();

  public recordTerminalClosed(terminalId: string): void {
    this.terminalLastClosed.set(terminalId, Date.now());
    console.log(`🔒 [LOCKOUT INTERLOCK] Terminal ${terminalId} marked recently closed at ${new Date().toISOString()}`);
  }

  /**
   * Safely parses an ISO date string into a valid Date object.
   * If string is malformed or invalid, safely defaults to current date.
   */
  private parseValidDate(dateStr?: string | null): Date {
    if (!dateStr || typeof dateStr !== 'string' || dateStr.trim() === '') {
      return new Date();
    }
    const parsed = new Date(dateStr);
    if (isNaN(parsed.getTime())) {
      console.warn(`⚠️ [OFFLINE SYNC] Received invalid timestamp "${dateStr}". Defaulting to current timestamp.`);
      return new Date();
    }
    return parsed;
  }

  startEnrollmentSession(
    terminalId: string = 'TERM-CL304',
    targetRole: 'STUDENT' | 'FACULTY' | 'ADMIN' = 'STUDENT',
    targetName?: string
  ): EnrollmentSession {
    this.activeEnrollment = {
      terminalId,
      targetRole,
      targetName,
      startedAt: new Date().toISOString(),
    };
    console.log(`🎯 [ENROLLMENT SESSION STARTED] Terminal: ${terminalId} | Target Role: ${targetRole}`);
    emitEnrollmentModeChanged({
      active: true,
      terminalId,
      targetRole,
      targetName,
    });
    return this.activeEnrollment;
  }

  stopEnrollmentSession(terminalId?: string): void {
    console.log(`⏹️ [ENROLLMENT SESSION STOPPED] Terminal: ${terminalId || this.activeEnrollment?.terminalId}`);
    this.activeEnrollment = null;
    emitEnrollmentModeChanged({
      active: false,
      terminalId: terminalId || 'TERM-CL304',
    });
  }

  getEnrollmentSession(terminalId?: string) {
    if (this.activeEnrollment) {
      if (!terminalId || this.activeEnrollment.terminalId === terminalId) {
        return {
          active: true,
          terminalId: this.activeEnrollment.terminalId,
          targetRole: this.activeEnrollment.targetRole,
          targetName: this.activeEnrollment.targetName,
          startedAt: this.activeEnrollment.startedAt,
        };
      }
    }
    return { active: false };
  }

  getLastScanned() {
    return this.lastScannedCard;
  }

  /**
   * Returns list of authorized faculty instructor UIDs and admin UIDs for a terminal
   * Cached by ESP32 in local NVS storage to allow offline session unlock/lock
   */
  async getAuthorizedFaculty(terminalId: string) {
    const sections = await prisma.section.findMany({
      where: { terminalId },
      include: {
        faculty: {
          select: { id: true, firstName: true, lastName: true, email: true, rfidUid: true, role: true, department: true },
        },
      },
    });

    const facultyMap = new Map<string, { rfidUid: string; name: string; role: Role; department: string | null }>();

    for (const s of sections) {
      if (s.faculty && s.faculty.rfidUid) {
        const cleanUid = this.normalizeRfid(s.faculty.rfidUid);
        facultyMap.set(cleanUid, {
          rfidUid: cleanUid,
          name: `Prof. ${s.faculty.firstName} ${s.faculty.lastName}`,
          role: s.faculty.role,
          department: s.faculty.department,
        });
      }
    }

    return Array.from(facultyMap.values());
  }

  /**
   * Processes a batch of offline attendance logs queued on the ESP32 terminal during network outage
   */
  async processOfflineSync(
    terminalId: string,
    payload: {
      sessionAction?: 'START' | 'CLOSE' | 'CONTINUE';
      facultyUid?: string;
      records: Array<{
        rfidUid?: string;
        cardUid?: string;
        timestamp?: string;
        authMethod?: string;
      }>;
    }
  ) {
    console.log(
      `\n🔄 [OFFLINE SYNC INGRESS] Terminal: ${terminalId} | Records: ${payload.records?.length || 0} | Action: ${
        payload.sessionAction || 'CONTINUE'
      }\n`
    );

    const records = payload.records || [];
    let syncedCount = 0;
    let duplicateCount = 0;
    let notEnrolledCount = 0;

    // 1. Identify active session for this terminal
    let activeSession = await prisma.session.findFirst({
      where: {
        terminalId,
        status: SessionStatus.OPEN,
      },
      include: {
        section: {
          include: {
            enrollments: true,
          },
        },
        faculty: true,
      },
      orderBy: { startTime: 'desc' },
    });

    // If terminal opened session offline, find faculty and create the session
    // CRITICAL FIX: Only create OPEN session if sessionAction is explicitly 'START'
    if (!activeSession && payload.facultyUid && payload.sessionAction === 'START') {
      const cleanFacultyUid = this.normalizeRfid(payload.facultyUid);
      const faculty = await prisma.user.findUnique({
        where: { rfidUid: cleanFacultyUid },
      });

      if (faculty && (faculty.role === Role.FACULTY || faculty.role === Role.ADMIN)) {
        let section = await prisma.section.findFirst({
          where: { terminalId, facultyId: faculty.id },
          include: { enrollments: true },
        });

        if (!section) {
          section = await prisma.section.findFirst({
            where: { terminalId },
            include: { enrollments: true },
          });
        }

        if (section) {
          const earliestTime =
            records.length > 0 ? this.parseValidDate(records[0].timestamp) : new Date();

          activeSession = await prisma.session.create({
            data: {
              sectionId: section.id,
              facultyId: faculty.id,
              terminalId,
              status: SessionStatus.OPEN,
              startTime: earliestTime,
              lateThresholdMins: section.defaultLateThresholdMins,
              cutThresholdMins: section.defaultCutThresholdMins,
            },
            include: {
              section: {
                include: {
                  enrollments: true,
                },
              },
              faculty: true,
            },
          });

          const activeDetails = await sessionService.getActiveSession(terminalId);

          emitSessionStarted({
            sessionId: activeSession.id,
            terminalId,
            sectionCode: section.sectionCode,
            courseName: section.courseName,
            roomNumber: section.roomNumber,
            facultyName: `Prof. ${faculty.firstName} ${faculty.lastName}`,
            startTime: activeSession.startTime.toISOString(),
            lateThresholdMins: activeSession.lateThresholdMins,
            cutThresholdMins: activeSession.cutThresholdMins,
            totalEnrolled: activeDetails.stats.totalEnrolled,
            roster: activeDetails.roster,
          });
          console.log(`✨ [OFFLINE SYNC] Resurrected offline session ${activeSession.id} for ${section.sectionCode}`);
        }
      }
    } else if (!activeSession && payload.facultyUid && payload.sessionAction === 'CLOSE') {
      // Session was opened AND closed offline while network was down.
      // Create directly as CLOSED so it is archived cleanly without spuriously unlocking the terminal!
      const cleanFacultyUid = this.normalizeRfid(payload.facultyUid);
      const faculty = await prisma.user.findUnique({
        where: { rfidUid: cleanFacultyUid },
      });

      if (faculty && (faculty.role === Role.FACULTY || faculty.role === Role.ADMIN)) {
        let section = await prisma.section.findFirst({
          where: { terminalId, facultyId: faculty.id },
          include: { enrollments: true },
        });

        if (!section) {
          section = await prisma.section.findFirst({
            where: { terminalId },
            include: { enrollments: true },
          });
        }

        if (section) {
          const earliestTime =
            records.length > 0 ? this.parseValidDate(records[0].timestamp) : new Date();
          const latestTime =
            records.length > 0 ? this.parseValidDate(records[records.length - 1].timestamp) : new Date();

          activeSession = await prisma.session.create({
            data: {
              sectionId: section.id,
              facultyId: faculty.id,
              terminalId,
              status: SessionStatus.CLOSED,
              startTime: earliestTime,
              endTime: latestTime,
              lateThresholdMins: section.defaultLateThresholdMins,
              cutThresholdMins: section.defaultCutThresholdMins,
            },
            include: {
              section: {
                include: {
                  enrollments: true,
                },
              },
              faculty: true,
            },
          });
          this.recordTerminalClosed(terminalId);
          console.log(`📁 [OFFLINE SYNC] Ingested completed offline session ${activeSession.id} directly as CLOSED.`);
        }
      }
    }

    if (!activeSession) {
      // Fallback: Check most recent session for this terminal
      const recentSession = await prisma.session.findFirst({
        where: { terminalId },
        include: {
          section: {
            include: { enrollments: true },
          },
          faculty: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      if (recentSession) {
        activeSession = recentSession;
      }
    }

    if (!activeSession) {
      return {
        statusCode: 404,
        success: false,
        message: `No active or configured session found for terminal ${terminalId}.`,
        syncedCount: 0,
        duplicateCount: 0,
        totalReceived: records.length,
      };
    }

    // 2. Process all offline attendance records sequentially
    const enrolledStudentIds = new Set(activeSession.section.enrollments.map((e) => e.studentId));

    for (const rec of records) {
      const rawUid = rec.rfidUid || rec.cardUid;
      if (!rawUid) continue;
      const cleanUid = this.normalizeRfid(rawUid);
      const student = await prisma.user.findUnique({
        where: { rfidUid: cleanUid },
      });

      if (!student) {
        console.warn(`[OFFLINE SYNC] Unregistered badge 0x${cleanUid} skipped.`);
        continue;
      }

      if (!enrolledStudentIds.has(student.id)) {
        notEnrolledCount++;
        console.warn(
          `[OFFLINE SYNC] Student ${student.firstName} ${student.lastName} not enrolled in ${activeSession.section.sectionCode}.`
        );
        continue;
      }

      // Check anti-passback in this session
      const existingLog = await prisma.attendanceLog.findUnique({
        where: {
          sessionId_studentId: {
            sessionId: activeSession.id,
            studentId: student.id,
          },
        },
      });

      if (existingLog) {
        duplicateCount++;
        continue;
      }

      // Calculate status based on tap timestamp vs session start
      const tapTime = this.parseValidDate(rec.timestamp);
      const elapsedMins = Math.max(0, (tapTime.getTime() - activeSession.startTime.getTime()) / (1000 * 60));

      let status: AttendanceStatus = AttendanceStatus.PRESENT;
      if (elapsedMins > activeSession.cutThresholdMins) {
        status = AttendanceStatus.CUT;
      } else if (elapsedMins > activeSession.lateThresholdMins) {
        status = AttendanceStatus.LATE;
      }

      let attendanceLog;
      try {
        attendanceLog = await prisma.attendanceLog.create({
          data: {
            sessionId: activeSession.id,
            studentId: student.id,
            status,
            authMethod: (rec.authMethod as AuthMethod) || AuthMethod.RFID_TAP,
            tapTimestamp: tapTime,
            reverseReceiptSent: false,
          },
        });
      } catch (err: any) {
        if (err.code === 'P2002') {
          duplicateCount++;
          continue;
        }
        throw err;
      }

      syncedCount++;

      // Dispatch reverse-receipt in background
      mailerService
        .sendReverseReceipt({
          logId: attendanceLog.id,
          studentEmail: student.email,
          studentName: `${student.firstName} ${student.lastName}`,
          sectionCode: activeSession.section.sectionCode,
          courseName: activeSession.section.courseName,
          roomNumber: activeSession.section.roomNumber,
          tapTime,
          authMethod: 'Offline RFID Tap (Auto-Synced)',
        })
        .catch(() => {});
    }

    // Refresh telemetry and emit update to React dashboard
    const activeDetails = await sessionService.getActiveSession(terminalId);
    emitAttendanceUpdated({
      sessionId: activeSession.id,
      terminalId,
      studentId: '',
      studentNumber: '',
      studentName: 'BATCH_OFFLINE_SYNC',
      status: AttendanceStatus.PRESENT,
      authMethod: AuthMethod.RFID_TAP,
      tapTimestamp: new Date().toISOString(),
      isManualOverride: false,
      stats: activeDetails.stats,
      roster: activeDetails.roster,
    });

    // If professor ended the session while offline, finalize it with ownership verification
    if (payload.sessionAction === 'CLOSE' && activeSession.status === SessionStatus.OPEN && payload.facultyUid) {
      const cleanFacultyUid = this.normalizeRfid(payload.facultyUid);
      const faculty = await prisma.user.findUnique({ where: { rfidUid: cleanFacultyUid } });
      if (faculty && (faculty.id === activeSession.facultyId || faculty.role === Role.ADMIN)) {
        await sessionService.closeSession(activeSession.id);
        this.recordTerminalClosed(terminalId);
        console.log(`🔒 [OFFLINE SYNC] Session ${activeSession.id} finalized per offline close request from Prof. ${faculty.lastName}.`);
      } else {
        console.warn(`⚠️ [OFFLINE SYNC GUARD] Suppressed close request: payload facultyUid (${cleanFacultyUid}) not authorized for active session.`);
      }
    }

    return {
      statusCode: 200,
      success: true,
      message: `Successfully synced ${syncedCount} offline record(s). (${duplicateCount} duplicate(s) rejected under anti-passback)`,
      syncedCount,
      duplicateCount,
      notEnrolledCount,
      totalReceived: records.length,
      sessionId: activeSession.id,
    };
  }
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
    console.log(`\n🏷️ [RFID TAP SCANNED] Terminal: ${terminalId} | Scanned Card UID: ${cleanRfid}\n`);

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

    // Cache last scanned card for live enrollment & terminal monitoring
    this.lastScannedCard = {
      rfidUid: cleanRfid,
      terminalId,
      timestamp: now.toISOString(),
      isRegistered: !!cardHolder,
      cardHolder: cardHolder
        ? {
            id: cardHolder.id,
            name: `${cardHolder.firstName} ${cardHolder.lastName}`,
            role: cardHolder.role,
            studentId: cardHolder.studentId,
          }
        : null,
    };

    emitCardScanned({
      rfidUid: cleanRfid,
      terminalId,
      timestamp: now.toISOString(),
      isRegistered: !!cardHolder,
      cardHolder: cardHolder
        ? {
            name: `${cardHolder.firstName} ${cardHolder.lastName}`,
            role: cardHolder.role,
            studentId: cardHolder.studentId,
          }
        : undefined,
    });

    // -----------------------------------------------------------------
    // SPECIAL ENROLLMENT MODE: Admin is actively scanning to add student/faculty
    // -----------------------------------------------------------------
    if (this.activeEnrollment && (!this.activeEnrollment.terminalId || this.activeEnrollment.terminalId === terminalId)) {
      console.log(`✨ [ENROLLMENT INTERCEPT] Live card 0x${cleanRfid} captured for new ${this.activeEnrollment.targetRole}!`);
      return {
        statusCode: 200,
        success: true,
        code: 'ENROLLMENT_CAPTURED',
        message: cardHolder
          ? `Badge 0x${cleanRfid} is already assigned to ${cardHolder.firstName} ${cardHolder.lastName}`
          : `Badge 0x${cleanRfid} captured live for new ${this.activeEnrollment.targetRole}`,
        data: {
          rfidUid: cleanRfid,
          isRegistered: !!cardHolder,
          cardHolderName: cardHolder ? `${cardHolder.firstName} ${cardHolder.lastName}` : null,
          targetRole: this.activeEnrollment.targetRole,
          targetName: this.activeEnrollment.targetName,
        },
      };
    }

    // -----------------------------------------------------------------
    // CASE 1: TERMINAL IS IN LOCKED STATE (No Active Session)
    // -----------------------------------------------------------------
    if (!activeSession) {
      if (!cardHolder) {
        return {
          statusCode: 404,
          success: false,
          code: 'UNREGISTERED_CARD',
          message: 'Terminal locked. Unregistered badge scanned.',
        };
      }

      // If a student tries to scan while terminal is locked -> REJECT (403 SESSION_LOCKED)
      if (cardHolder.role === Role.STUDENT) {
        return {
          statusCode: 403,
          success: false,
          code: 'SESSION_LOCKED',
          message: 'TERMINAL LOCKED: Tap Faculty badge to initiate session.',
        };
      }

      // If an Admin tries to scan while terminal is locked -> REJECT (Option 1: Faculty Only)
      if (cardHolder.role === Role.ADMIN) {
        return {
          statusCode: 403,
          success: false,
          code: 'UNAUTHORIZED_FACULTY',
          message: 'ACCESS RESTRICTED: Admin badges cannot initiate classroom sessions. An assigned faculty badge is required.',
        };
      }

      // Interlock Guard: If terminal was locked within the last 4000ms, suppress immediate restart
      const lastClosed = this.terminalLastClosed.get(terminalId) || 0;
      const elapsedSinceClose = Date.now() - lastClosed;
      if (elapsedSinceClose < 4000) {
        console.warn(`⏳ [DEBOUNCE] Terminal ${terminalId} was locked ${elapsedSinceClose}ms ago. Suppressing rapid re-open.`);
        return {
          statusCode: 200,
          success: false,
          code: 'SESSION_LOCKED',
          message: 'Terminal locked. Please remove badge before starting a new session.',
        };
      }

      // If Faculty scans master badge -> UNLOCK TERMINAL & OPEN SESSION
      // 1. Try finding section specifically assigned to this faculty on this terminal
      const section = await prisma.section.findFirst({
        where: { terminalId, facultyId: cardHolder.id },
        include: { faculty: true },
      });

      // 3. Security Boundary: If this terminal belongs to another faculty, REJECT unauthorized faculty!
      if (!section) {
        const assignedSection = await prisma.section.findFirst({
          where: { terminalId },
          include: { faculty: true },
        });

        if (assignedSection && assignedSection.facultyId !== cardHolder.id) {
          console.warn(`⚠️ [UNAUTHORIZED FACULTY TAP] Prof. ${cardHolder.lastName} attempted to access terminal ${terminalId} assigned to Prof. ${assignedSection.faculty.lastName}`);
          return {
            statusCode: 403,
            success: false,
            code: 'UNAUTHORIZED_FACULTY',
            message: `ACCESS DENIED: Room ${assignedSection.roomNumber} is assigned to Prof. ${assignedSection.faculty.lastName}. You are not authorized for this terminal.`,
          };
        }

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

    // SUB-CASE 2A: Admin or Faculty Badge scanned
    if (cardHolder.role === Role.ADMIN) {
      return {
        statusCode: 403,
        success: false,
        code: 'UNAUTHORIZED_FACULTY',
        message: `ACCESS RESTRICTED: Admin badges cannot close classroom sessions. Only Prof. ${activeSession.faculty.lastName} can end this session.`,
      };
    }

    if (cardHolder.role === Role.FACULTY) {
      // Prevent other faculty from closing someone else's session
      if (cardHolder.id !== activeSession.facultyId) {
        return {
          statusCode: 403,
          success: false,
          code: 'UNAUTHORIZED_FACULTY',
          message: `ACCESS DENIED: Session was initiated by Prof. ${activeSession.faculty.lastName}. Only they can end this session.`,
        };
      }

      const closeResult = await sessionService.closeSession(activeSession.id);
      this.recordTerminalClosed(terminalId);

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
    try {
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
    } catch (err: any) {
      if (err.code === 'P2002') {
        // Unique constraint collision under race condition -> Gracefully treat as Anti-Passback duplicate
        return {
          statusCode: 409,
          success: false,
          code: 'ALREADY_RECORDED',
          message: `ANTI-PASSBACK ALERT: ${cardHolder.firstName} ${cardHolder.lastName} is already checked in.`,
          data: {
            studentId: cardHolder.studentId,
            studentName: `${cardHolder.firstName} ${cardHolder.lastName}`,
            status,
            tapTime: now,
          },
        };
      }
      throw err;
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
