import { Request, Response } from 'express';
import { z } from 'zod';
import { AttendanceStatus, Role, SessionStatus } from '@prisma/client';
import { sessionService } from '../services/session.service.js';
import { hardwareService } from '../services/hardware.service.js';
import { reportService } from '../services/report.service.js';
import { mailerService } from '../services/mailer.service.js';
import { emitSessionStarted } from '../sockets/telemetry.socket.js';
import prisma from '../config/prisma.js';
import { AuthRequest } from '../middlewares/auth.middleware.js';

const thresholdSchema = z.object({
  lateThresholdMins: z.number().int().min(1, 'Late threshold must be at least 1 minute'),
  cutThresholdMins: z.number().int().min(2, 'Cut threshold must be greater than late threshold'),
});

const overrideSchema = z.object({
  studentId: z.string().min(1, 'Student identifier is required'),
  status: z.nativeEnum(AttendanceStatus, { errorMap: () => ({ message: 'Invalid attendance status' }) }),
  reason: z.string().min(1, 'Override reason / remarks required'),
});

const emailReportSchema = z.object({
  recipientEmail: z.string().email('Invalid email address').optional(),
});

export interface HttpError extends Error {
  statusCode?: number;
}

export function createHttpError(message: string, statusCode: number): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function getErrorStatusCode(err: unknown, defaultCode = 500): number {
  if (err && typeof err === 'object' && 'statusCode' in err && typeof (err as HttpError).statusCode === 'number') {
    return (err as HttpError).statusCode!;
  }
  return defaultCode;
}

/**
 * Asserts session ownership for RBAC authorization:
 * - ADMIN: Unrestricted authority over all sessions
 * - FACULTY: Authorized only over sections/sessions where user.id === sessionFacultyId
 * - STUDENT (and any other role): Strictly forbidden (HTTP 403)
 */
export function assertSessionOwnership(user?: { id: string; role: Role }, sessionFacultyId?: string): void {
  if (!user) {
    throw createHttpError('Authentication required', 401);
  }
  if (user.role === Role.ADMIN) return;
  if (user.role === Role.FACULTY && user.id === sessionFacultyId) return;
  throw createHttpError('Forbidden: You do not possess authority over this session.', 403);
}

export class SessionController {
  /**
   * GET /api/v1/sessions/active/:terminalId
   */
  async getActiveSession(req: Request, res: Response): Promise<void> {
    try {
      const terminalId = req.params.terminalId as string;
      const data = await sessionService.getActiveSession(terminalId);
      res.status(200).json({ success: true, data });
    } catch (err: unknown) {
      res.status(500).json({ success: false, message: getErrorMessage(err) });
    }
  }

  /**
   * GET /api/v1/sessions/:id
   */
  async getSessionDetail(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const session = await prisma.session.findUnique({
        where: { id },
        include: {
          section: true,
          faculty: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          attendanceLogs: {
            include: {
              student: {
                select: { id: true, studentId: true, firstName: true, lastName: true, email: true, rfidUid: true },
              },
            },
            orderBy: { student: { lastName: 'asc' } },
          },
        },
      });

      if (!session) {
        res.status(404).json({ success: false, message: 'Session not found' });
        return;
      }

      // Assert session authority (Admin or Session Faculty)
      assertSessionOwnership(req.user, session.facultyId);

      res.status(200).json({ success: true, data: session });
    } catch (err: unknown) {
      res.status(getErrorStatusCode(err, 500)).json({ success: false, message: getErrorMessage(err) });
    }
  }

  /**
   * PATCH /api/v1/sessions/:id/thresholds
   */
  async updateThresholds(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const session = await prisma.session.findUnique({ where: { id } });
      if (!session) {
        res.status(404).json({ success: false, message: 'Session not found' });
        return;
      }

      // Assert session authority (Admin or Session Faculty)
      assertSessionOwnership(req.user, session.facultyId);

      const parsed = thresholdSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: parsed.error.issues[0]?.message || 'Invalid thresholds',
        });
        return;
      }

      const { lateThresholdMins, cutThresholdMins } = parsed.data;
      const updated = await sessionService.updatePunctualityThresholds(id, lateThresholdMins, cutThresholdMins);

      res.status(200).json({
        success: true,
        message: 'Punctuality thresholds updated and student statuses recalculated.',
        data: updated,
      });
    } catch (err: unknown) {
      res.status(getErrorStatusCode(err, 400)).json({ success: false, message: getErrorMessage(err) });
    }
  }

  /**
   * PATCH /api/v1/sessions/:id/override
   */
  async applyOverride(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const session = await prisma.session.findUnique({ where: { id } });
      if (!session) {
        res.status(404).json({ success: false, message: 'Session not found' });
        return;
      }

      // Assert session authority (Admin or Session Faculty)
      assertSessionOwnership(req.user, session.facultyId);

      const parsed = overrideSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: parsed.error.issues[0]?.message || 'Invalid override data',
        });
        return;
      }

      const result = await sessionService.applyManualOverride({
        sessionId: id,
        studentId: parsed.data.studentId,
        status: parsed.data.status,
        reason: parsed.data.reason,
        facultyId: req.user?.id,
      });

      res.status(200).json({
        success: true,
        message: `Manual status override applied: ${parsed.data.status}`,
        data: result,
      });
    } catch (err: unknown) {
      res.status(getErrorStatusCode(err, 400)).json({ success: false, message: getErrorMessage(err) });
    }
  }

  /**
   * POST /api/v1/sessions/start
   * Start a new active session via faculty dashboard
   */
  async startSession(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return;
      }

      const { sectionId, terminalId } = req.body;
      if (!sectionId) {
        res.status(400).json({ success: false, message: 'Section identifier is required' });
        return;
      }

      const section = await prisma.section.findUnique({
        where: { id: sectionId },
        include: { faculty: true },
      });

      if (!section) {
        res.status(404).json({ success: false, message: 'Course section not found' });
        return;
      }

      // Assert section authority (Admin or Section Faculty)
      assertSessionOwnership(req.user, section.facultyId);

      const activeTerminalId = terminalId || section.terminalId;

      // Check if an open session already exists on this terminal
      const existing = await prisma.session.findFirst({
        where: { terminalId: activeTerminalId, status: SessionStatus.OPEN },
      });

      if (existing) {
        res.status(409).json({
          success: false,
          message: `Terminal ${activeTerminalId} already has an active session in progress. Please close it first.`,
        });
        return;
      }

      const now = new Date();
      const newSession = await prisma.session.create({
        data: {
          sectionId: section.id,
          facultyId: req.user.id,
          terminalId: activeTerminalId,
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

      // Broadcast telemetry
      const activeDetails = await sessionService.getActiveSession(activeTerminalId);
      emitSessionStarted({
        sessionId: newSession.id,
        terminalId: activeTerminalId,
        sectionCode: section.sectionCode,
        courseName: section.courseName,
        roomNumber: section.roomNumber,
        facultyName: req.user.role === Role.ADMIN ? `${req.user.firstName} ${req.user.lastName}` : `Prof. ${req.user.firstName} ${req.user.lastName}`,
        startTime: now.toISOString(),
        lateThresholdMins: newSession.lateThresholdMins,
        cutThresholdMins: newSession.cutThresholdMins,
        totalEnrolled: activeDetails.stats.totalEnrolled,
        roster: activeDetails.roster,
      });

      res.status(201).json({
        success: true,
        message: `Classroom attendance session initiated for ${section.sectionCode}`,
        data: newSession,
      });
    } catch (err: unknown) {
      res.status(500).json({ success: false, message: getErrorMessage(err) });
    }
  }

  /**
   * POST /api/v1/sessions/:id/close
   */
  async closeSession(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const session = await prisma.session.findUnique({ where: { id } });
      if (!session) {
        res.status(404).json({ success: false, message: 'Session not found' });
        return;
      }

      // Assert session authority (Admin or Session Faculty)
      assertSessionOwnership(req.user, session.facultyId);

      const result = await sessionService.closeSession(id);
      if (session.terminalId) {
        hardwareService.recordTerminalClosed(session.terminalId);
      }
      res.status(200).json({
        success: true,
        message: 'Class session closed. Attendance finalized and reports compiled.',
        data: result,
      });
    } catch (err: unknown) {
      res.status(getErrorStatusCode(err, 400)).json({ success: false, message: getErrorMessage(err) });
    }
  }

  /**
   * GET /api/v1/sessions/:id/export/pdf
   */
  async downloadPdf(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const session = await prisma.session.findUnique({ where: { id } });
      if (!session) {
        res.status(404).json({ success: false, message: 'Session not found' });
        return;
      }
      assertSessionOwnership(req.user, session.facultyId);

      const { pdfBuffer } = await reportService.generateSessionReports(id);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=ORCHESTRA_Report_${id.slice(0, 8)}.pdf`);
      res.send(pdfBuffer);
    } catch (err: unknown) {
      res.status(getErrorStatusCode(err, 500)).json({ success: false, message: getErrorMessage(err) });
    }
  }

  /**
   * GET /api/v1/sessions/:id/export/csv
   */
  async downloadCsv(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const session = await prisma.session.findUnique({ where: { id } });
      if (!session) {
        res.status(404).json({ success: false, message: 'Session not found' });
        return;
      }
      assertSessionOwnership(req.user, session.facultyId);

      const { csvString } = await reportService.generateSessionReports(id);

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=ORCHESTRA_Roster_${id.slice(0, 8)}.csv`);
      res.send(csvString);
    } catch (err: unknown) {
      res.status(getErrorStatusCode(err, 500)).json({ success: false, message: getErrorMessage(err) });
    }
  }

  /**
   * GET /api/v1/sessions/:id/export/xlsx
   */
  async downloadExcel(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const session = await prisma.session.findUnique({ where: { id } });
      if (!session) {
        res.status(404).json({ success: false, message: 'Session not found' });
        return;
      }
      assertSessionOwnership(req.user, session.facultyId);

      const { xlsxBuffer } = await reportService.generateSessionReports(id);

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=ORCHESTRA_Attendance_${id.slice(0, 8)}.xlsx`);
      res.send(xlsxBuffer);
    } catch (err: unknown) {
      res.status(getErrorStatusCode(err, 500)).json({ success: false, message: getErrorMessage(err) });
    }
  }

  /**
   * POST /api/v1/sessions/:id/email-report
   * Manually send or resend attendance report via email
   */
  async emailReport(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const parsed = emailReportSchema.safeParse(req.body);

      const session = await prisma.session.findUnique({
        where: { id },
        include: { section: true, faculty: true, attendanceLogs: true },
      });

      if (!session) {
        res.status(404).json({ success: false, message: 'Session not found' });
        return;
      }

      // Assert session authority (Admin or Session Faculty)
      assertSessionOwnership(req.user, session.facultyId);

      const { pdfPath, csvPath, xlsxPath } = await reportService.generateSessionReports(id);

      const enrollments = await prisma.enrollment.findMany({ where: { sectionId: session.sectionId } });
      const logsMap = new Map(session.attendanceLogs.map((l) => [l.studentId, l]));
      const roster = enrollments.map((e) => ({
        studentId: e.studentId,
        status: logsMap.get(e.studentId)?.status || AttendanceStatus.ABSENT,
      }));
      const stats = sessionService.calculateStats(roster);

      const recipient = parsed.success && parsed.data.recipientEmail ? parsed.data.recipientEmail : session.faculty.email;

      await mailerService.sendFacultySessionReport({
        facultyEmail: session.faculty.email,
        facultyName: `${session.faculty.firstName} ${session.faculty.lastName}`,
        sectionCode: session.section.sectionCode,
        courseName: session.section.courseName,
        pdfPath,
        csvPath,
        xlsxPath,
        recipientEmail: recipient,
        stats,
      });

      res.status(200).json({
        success: true,
        message: `Attendance report successfully dispatched to ${recipient}`,
      });
    } catch (err: unknown) {
      res.status(getErrorStatusCode(err, 500)).json({ success: false, message: getErrorMessage(err) });
    }
  }

  /**
   * GET /api/v1/sessions
   * List sessions with rich filtering (from, to, sectionId, facultyId, status)
   */
  async listSessions(req: Request, res: Response): Promise<void> {
    try {
      const { from, to, sectionId, facultyId, status } = req.query;

      const whereClause: any = {};

      if (sectionId && typeof sectionId === 'string') {
        whereClause.sectionId = sectionId;
      }

      if (facultyId && typeof facultyId === 'string') {
        whereClause.facultyId = facultyId;
      }

      if (status && typeof status === 'string' && Object.values(SessionStatus).includes(status as SessionStatus)) {
        whereClause.status = status as SessionStatus;
      }

      if (from || to) {
        whereClause.startTime = {};
        if (from && typeof from === 'string') {
          whereClause.startTime.gte = new Date(from);
        }
        if (to && typeof to === 'string') {
          whereClause.startTime.lte = new Date(to);
        }
      }

      const sessions = await prisma.session.findMany({
        where: whereClause,
        take: 50,
        orderBy: { startTime: 'desc' },
        include: {
          section: true,
          faculty: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          _count: {
            select: { attendanceLogs: true },
          },
        },
      });

      res.status(200).json({ success: true, data: sessions });
    } catch (err: unknown) {
      res.status(500).json({ success: false, message: getErrorMessage(err) });
    }
  }

  /**
   * GET /api/v1/sessions/my
   * List sessions for the authenticated faculty member
   */
  async getMySessions(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return;
      }

      const { from, to, sectionId, status } = req.query;
      const whereClause: any = {};
      if (req.user.role !== Role.ADMIN) {
        whereClause.facultyId = req.user.id;
      }

      if (sectionId && typeof sectionId === 'string') {
        whereClause.sectionId = sectionId;
      }

      if (status && typeof status === 'string' && Object.values(SessionStatus).includes(status as SessionStatus)) {
        whereClause.status = status as SessionStatus;
      }

      if (from || to) {
        whereClause.startTime = {};
        if (from && typeof from === 'string') {
          whereClause.startTime.gte = new Date(from);
        }
        if (to && typeof to === 'string') {
          whereClause.startTime.lte = new Date(to);
        }
      }

      const sessions = await prisma.session.findMany({
        where: whereClause,
        take: 50,
        orderBy: { startTime: 'desc' },
        include: {
          section: true,
          _count: {
            select: { attendanceLogs: true },
          },
        },
      });

      res.status(200).json({ success: true, data: sessions });
    } catch (err: unknown) {
      res.status(500).json({ success: false, message: getErrorMessage(err) });
    }
  }
}

export const sessionController = new SessionController();
export default sessionController;
