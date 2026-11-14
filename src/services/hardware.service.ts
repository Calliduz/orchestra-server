import { SessionStatus, AttendanceStatus, AuthMethod, Role } from '@prisma/client';
import prisma from '../config/prisma.js';
import { sessionService } from './session.service.js';
import { mailerService } from './mailer.service.js';
import { emitSessionStarted, emitAttendanceUpdated, emitCardScanned, emitEnrollmentModeChanged, emitTerminalHeartbeat, emitQuietModeChanged } from '../sockets/telemetry.socket.js';

export interface TerminalTelemetry {
  terminalId: string;
  rssi: number;
  freeHeap: number;
  uptimeSec: number;
  readerStatus: string;
  version: string;
  lastSeen: string | null;
  status: 'ONLINE' | 'WEAK_RSSI' | 'OFFLINE';
  roomNumber?: string;
  isQuietMode?: boolean;
}

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
    | 'SECTION_DISAMBIGUATION_REQUIRED'
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

  // Fleet telemetry in-memory cache
  private terminalFleet = new Map<string, TerminalTelemetry>();

  // Quiet Mode explicit toggle overrides (terminalId -> boolean)
  private quietModeOverrides = new Map<string, boolean>();

  public async recordHeartbeat(data: {
    terminalId: string;
    rssi: number;
    freeHeap: number;
    uptimeSec: number;
    readerStatus?: string | null;
    version?: string | null;
  }): Promise<TerminalTelemetry> {
    const { terminalId, rssi, freeHeap, uptimeSec, readerStatus, version } = data;
    const nowIso = new Date().toISOString();

    // Determine signal status based on RSSI
    let status: 'ONLINE' | 'WEAK_RSSI' | 'OFFLINE' = 'ONLINE';
    if (rssi < -80) {
      status = 'WEAK_RSSI';
    }

    // Lookup room number from section table if available
    const section = await prisma.section.findFirst({
      where: { terminalId },
      select: { roomNumber: true },
    });

    const isQuiet = await this.isQuietModeActive(terminalId);

    const telemetry: TerminalTelemetry = {
      terminalId,
      rssi,
      freeHeap,
      uptimeSec,
      readerStatus: readerStatus || 'OK',
      version: version || 'v1.0.4',
      lastSeen: nowIso,
      status,
      roomNumber: section?.roomNumber || 'CLASSROOM',
      isQuietMode: isQuiet,
    };

    this.terminalFleet.set(terminalId, telemetry);
    emitTerminalHeartbeat(telemetry);

    return telemetry;
  }

  public async getFleetTerminals(): Promise<TerminalTelemetry[]> {
    // Also discover any configured terminals from sections in the database
    const sections = await prisma.section.findMany({
      select: { terminalId: true, roomNumber: true },
      distinct: ['terminalId'],
    });

    const now = Date.now();
    const result: TerminalTelemetry[] = [];

    // Ensure all provisioned terminals exist in the cache
    for (const sec of sections) {
      if (!this.terminalFleet.has(sec.terminalId)) {
        this.terminalFleet.set(sec.terminalId, {
          terminalId: sec.terminalId,
          rssi: -99,
          freeHeap: 0,
          uptimeSec: 0,
          readerStatus: 'STANDBY',
          version: 'v1.0.4',
          lastSeen: null,
          status: 'OFFLINE',
          roomNumber: sec.roomNumber,
          isQuietMode: false,
        });
      }
    }

    // Default primary terminal if none in DB
    if (!this.terminalFleet.has('TERM-CL304')) {
      this.terminalFleet.set('TERM-CL304', {
        terminalId: 'TERM-CL304',
        rssi: -65,
        freeHeap: 215000,
        uptimeSec: 3600,
        readerStatus: 'OK',
        version: 'v1.0.4-PRO',
        lastSeen: new Date().toISOString(),
        status: 'ONLINE',
        roomNumber: 'LAB-304',
        isQuietMode: false,
      });
    }

    for (const [id, tele] of this.terminalFleet.entries()) {
      let currentStatus = tele.status;
      if (tele.lastSeen) {
        const elapsedSinceLastSeen = now - new Date(tele.lastSeen).getTime();
        if (elapsedSinceLastSeen > 120000) { // 2 minutes threshold for offline alert
          currentStatus = 'OFFLINE';
        }
      } else {
        currentStatus = 'OFFLINE';
      }

      const isQuiet = await this.isQuietModeActive(id);

      result.push({
        ...tele,
        status: currentStatus,
        isQuietMode: isQuiet,
      });
    }

    return result;
  }

  public async isQuietModeActive(terminalId: string): Promise<boolean> {
    if (this.quietModeOverrides.has(terminalId)) {
      return this.quietModeOverrides.get(terminalId)!;
    }

    // Check active session for this terminal
    const active = await sessionService.getActiveSession(terminalId);
    if (active && !active.isLocked && active.session) {
      const elapsedMins = Math.floor((Date.now() - new Date(active.session.startTime).getTime()) / 60000);
      if (elapsedMins >= (active.session.lateThresholdMins || 15)) {
        return true;
      }
    }

    return false;
  }

  public async toggleQuietMode(terminalId: string, enabled?: boolean): Promise<{ terminalId: string; isQuietMode: boolean }> {
    let nextState: boolean;
    if (typeof enabled === 'boolean') {
      nextState = enabled;
    } else {
      const current = await this.isQuietModeActive(terminalId);
      nextState = !current;
    }

    this.quietModeOverrides.set(terminalId, nextState);
    emitQuietModeChanged({ terminalId, isQuietMode: nextState });

    // Update fleet cache if terminal exists
    const cached = this.terminalFleet.get(terminalId);
    if (cached) {
      cached.isQuietMode = nextState;
      this.terminalFleet.set(terminalId, cached);
    }

    return { terminalId, isQuietMode: nextState };
  }

  public clearQuietModeOverride(terminalId: string): void {
    if (this.quietModeOverrides.has(terminalId)) {
      this.quietModeOverrides.delete(terminalId);
      console.log(`🔇 [QUIET_MODE] Cleared quiet mode override for terminal ${terminalId}`);
    }
  }

  public recordTerminalClosed(terminalId: string): void {
    this.terminalLastClosed.set(terminalId, Date.now());
    this.clearQuietModeOverride(terminalId);
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
      const facultySections = await prisma.section.findMany({
        where: { terminalId, facultyId: cardHolder.id },
        orderBy: { id: 'asc' },
        include: { faculty: true },
      });

      if (facultySections.length === 0) {
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

      let section: any = null;

      if (facultySections.length === 1) {
        section = facultySections[0];
      } else {
        // Schedule-Aware Section Resolver
        const matched = this.filterSectionsBySchedule(facultySections, now);

        if (matched.length === 1) {
          section = matched[0];
          console.log(`🎯 [SCHEDULE RESOLVER] Auto-selected section ${section.sectionCode} based on current schedule window.`);
        } else {
          // Multiple match schedule or none match immediate schedule window -> prompt OLED disambiguation
          const candidateList = matched.length > 1 ? matched : facultySections;
          console.log(`🤔 [DISAMBIGUATION REQUIRED] Terminal ${terminalId} has ${candidateList.length} candidate sections for Prof. ${cardHolder.lastName}`);
          return {
            statusCode: 200,
            success: true,
            code: 'SECTION_DISAMBIGUATION_REQUIRED',
            message: `Multiple sections available. Please select section on keypad (1-${Math.min(candidateList.length, 4)}).`,
            data: {
              terminalId,
              facultyId: cardHolder.id,
              facultyUid: cleanRfid,
              facultyName: `Prof. ${cardHolder.firstName} ${cardHolder.lastName}`,
              sections: candidateList.map((sec, idx) => ({
                index: idx + 1,
                id: sec.id,
                sectionCode: sec.sectionCode,
                courseName: sec.courseName,
                roomNumber: sec.roomNumber,
                scheduleDay: sec.scheduleDay,
                scheduleTime: sec.scheduleTime,
                scheduleEndTime: sec.scheduleEndTime,
              })),
            },
          };
        }
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

  /**
   * Evaluates candidate sections against the current day and time schedule window (±30 mins).
   */
  filterSectionsBySchedule(sections: any[], date: Date = new Date()): any[] {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const currentDay = dayNames[date.getDay()];
    const currentMinutes = date.getHours() * 60 + date.getMinutes();

    // Mapping of day of week index to standard university scheduling tokens
    const dayTokensMap: Record<number, string[]> = {
      0: ['sun', 'sunday', 'u', 'daily'],
      1: ['mon', 'monday', 'm', 'mwf', 'mw', 'daily'],
      2: ['tue', 'tues', 'tuesday', 't', 'tth', 'tf', 'daily'],
      3: ['wed', 'wednesday', 'w', 'mwf', 'mw', 'daily'],
      4: ['thu', 'thur', 'thurs', 'thursday', 'th', 'tth', 'r', 'daily'],
      5: ['fri', 'friday', 'f', 'mwf', 'tf', 'fs', 'daily'],
      6: ['sat', 'saturday', 'sa', 's', 'fs', 'daily'],
    };

    const validTokensToday = dayTokensMap[date.getDay()] || [currentDay.toLowerCase()];

    return sections.filter((sec) => {
      // 1. Day of week match
      if (sec.scheduleDay) {
        const schedDay = sec.scheduleDay.trim().toLowerCase();
        // Check if raw schedule contains any valid day token or if tokenized words match
        const parts: string[] = schedDay.split(/[\s,/\-]+/).filter(Boolean);
        const matchesDay =
          validTokensToday.includes(schedDay) ||
          parts.some((p: string) => validTokensToday.includes(p)) ||
          validTokensToday.some((token: string) => token.length > 2 && schedDay.includes(token));

        if (!matchesDay) return false;
      }

      // 2. Time window match (±30 mins of scheduleTime, or between start-30m and scheduleEndTime)
      if (sec.scheduleTime) {
        const timeParts = sec.scheduleTime.split(':').map(Number);
        if (timeParts.length >= 2 && !isNaN(timeParts[0]) && !isNaN(timeParts[1])) {
          const startMinutes = timeParts[0] * 60 + timeParts[1];
          let endMinutes = startMinutes + 30; // default 30-min window

          if (sec.scheduleEndTime) {
            const endParts = sec.scheduleEndTime.split(':').map(Number);
            if (endParts.length >= 2 && !isNaN(endParts[0]) && !isNaN(endParts[1])) {
              endMinutes = endParts[0] * 60 + endParts[1];
            }
          }

          const inWindow =
            currentMinutes >= startMinutes - 30 &&
            currentMinutes <= Math.max(endMinutes, startMinutes + 30);

          if (!inWindow) return false;
        }
      }

      return true;
    });
  }

  /**
   * Manually selects and activates a section when terminal requires disambiguation
   */
  async selectSection(params: {
    terminalId: string;
    sectionId?: string;
    index?: number;
    facultyId?: string;
    facultyUid?: string;
  }): Promise<HardwareTapResult> {
    const { terminalId, sectionId, index, facultyId, facultyUid } = params;

    // Check if terminal is already open
    const activeSession = await prisma.session.findFirst({
      where: { terminalId, status: SessionStatus.OPEN },
      include: { section: true, faculty: true },
    });

    if (activeSession) {
      return {
        statusCode: 400,
        success: false,
        code: 'ERROR',
        message: `Terminal ${terminalId} already has an active session for ${activeSession.section.sectionCode}.`,
        data: activeSession,
      };
    }

    let targetSection: any = null;

    if (sectionId) {
      targetSection = await prisma.section.findUnique({
        where: { id: sectionId },
        include: { faculty: true },
      });

      if (targetSection && targetSection.terminalId && targetSection.terminalId !== terminalId) {
        return {
          statusCode: 400,
          success: false,
          code: 'ERROR',
          message: `Section ${targetSection.sectionCode} is not assigned to terminal ${terminalId}.`,
        };
      }
    } else if (index !== undefined) {
      let resolvedFacultyId = facultyId;
      if (!resolvedFacultyId && facultyUid) {
        const cleanUid = this.normalizeRfid(facultyUid);
        const fac = await prisma.user.findUnique({ where: { rfidUid: cleanUid } });
        if (fac) resolvedFacultyId = fac.id;
      }

      // If neither facultyId nor facultyUid is provided, attempt to resolve unique faculty from terminal
      if (!resolvedFacultyId) {
        const termSections = await prisma.section.findMany({
          where: { terminalId },
          select: { facultyId: true },
          distinct: ['facultyId'],
        });
        if (termSections.length === 1) {
          resolvedFacultyId = termSections[0].facultyId;
        }
      }

      if (!resolvedFacultyId) {
        return {
          statusCode: 400,
          success: false,
          code: 'ERROR',
          message: 'Unable to identify faculty for section selection.',
        };
      }

      const candidateSections = await prisma.section.findMany({
        where: { terminalId, facultyId: resolvedFacultyId },
        orderBy: { id: 'asc' },
        include: { faculty: true },
      });

      const selectedIndex = Number(index) - 1;
      if (selectedIndex >= 0 && selectedIndex < candidateSections.length) {
        targetSection = candidateSections[selectedIndex];
      }
    }

    if (!targetSection) {
      return {
        statusCode: 404,
        success: false,
        code: 'ERROR',
        message: 'Invalid section selection or section not found.',
      };
    }

    const now = new Date();
    const newSession = await prisma.session.create({
      data: {
        sectionId: targetSection.id,
        facultyId: targetSection.facultyId,
        terminalId,
        status: SessionStatus.OPEN,
        startTime: now,
        lateThresholdMins: targetSection.defaultLateThresholdMins,
        cutThresholdMins: targetSection.defaultCutThresholdMins,
      },
      include: {
        section: true,
        faculty: true,
      },
    });

    const activeDetails = await sessionService.getActiveSession(terminalId);

    emitSessionStarted({
      sessionId: newSession.id,
      terminalId,
      sectionCode: targetSection.sectionCode,
      courseName: targetSection.courseName,
      roomNumber: targetSection.roomNumber,
      facultyName: `Prof. ${targetSection.faculty.firstName} ${targetSection.faculty.lastName}`,
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
      message: `SESSION OPENED: ${targetSection.sectionCode} (${targetSection.roomNumber})`,
      data: {
        sessionId: newSession.id,
        sectionCode: targetSection.sectionCode,
        courseName: targetSection.courseName,
        facultyName: `${targetSection.faculty.firstName} ${targetSection.faculty.lastName}`,
        startTime: now.toISOString(),
        lateThresholdMins: newSession.lateThresholdMins,
        cutThresholdMins: newSession.cutThresholdMins,
      },
    };
  }
}

export const hardwareService = new HardwareService();
export default hardwareService;
