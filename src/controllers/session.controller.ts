import { Request, Response } from 'express';
import { z } from 'zod';
import { AttendanceStatus } from '@prisma/client';
import { sessionService } from '../services/session.service.js';
import { reportService } from '../services/report.service.js';
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

export class SessionController {
  /**
   * GET /api/v1/sessions/active/:terminalId
   */
  async getActiveSession(req: Request, res: Response): Promise<void> {
    try {
      const terminalId = req.params.terminalId as string;
      const data = await sessionService.getActiveSession(terminalId);
      res.status(200).json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * PATCH /api/v1/sessions/:id/thresholds
   */
  async updateThresholds(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
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
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  /**
   * PATCH /api/v1/sessions/:id/override
   */
  async applyOverride(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
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
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  /**
   * POST /api/v1/sessions/:id/close
   */
  async closeSession(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await sessionService.closeSession(id);
      res.status(200).json({
        success: true,
        message: 'Class session closed. Attendance finalized and reports compiled.',
        data: result,
      });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  /**
   * GET /api/v1/sessions/:id/export/pdf
   */
  async downloadPdf(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const { pdfBuffer } = await reportService.generateSessionReports(id);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=ORCHESTRA_Report_${id.slice(0, 8)}.pdf`);
      res.send(pdfBuffer);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * GET /api/v1/sessions/:id/export/csv
   */
  async downloadCsv(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const { csvString } = await reportService.generateSessionReports(id);

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=ORCHESTRA_Roster_${id.slice(0, 8)}.csv`);
      res.send(csvString);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * GET /api/v1/sessions
   * List recent sessions for faculty dashboard
   */
  async listSessions(req: Request, res: Response): Promise<void> {
    try {
      const sessions = await prisma.session.findMany({
        take: 20,
        orderBy: { startTime: 'desc' },
        include: {
          section: true,
          faculty: {
            select: { firstName: true, lastName: true, email: true },
          },
          _count: {
            select: { attendanceLogs: true },
          },
        },
      });

      res.status(200).json({ success: true, data: sessions });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
}

export const sessionController = new SessionController();
export default sessionController;
