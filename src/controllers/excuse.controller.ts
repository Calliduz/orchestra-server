import { Response } from 'express';
import path from 'path';
import fs from 'fs';
import { Role, AttendanceStatus } from '@prisma/client';
import prisma from '../config/prisma.js';
import { AuthRequest } from '../middlewares/auth.middleware.js';
import { emitAttendanceUpdated, emitExcuseReviewed } from '../sockets/telemetry.socket.js';
import { sessionService } from '../services/session.service.js';

export class ExcuseController {
  /**
   * POST /api/v1/excuses
   * Student submits an absence justification slip with optional file attachment
   */
  async submitExcuse(req: AuthRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ success: false, message: 'Authentication required.' });
        return;
      }
      const studentId = user.id;

      const { attendanceLogId, reason } = req.body;

      if (!attendanceLogId || !reason || reason.trim() === '') {
        res.status(400).json({
          success: false,
          message: 'Both attendanceLogId and a valid reason are required.',
        });
        return;
      }

      // Verify attendance log exists and belongs to this student
      const log = await prisma.attendanceLog.findUnique({
        where: { id: attendanceLogId },
        include: {
          session: {
            include: { section: true },
          },
          excuseRequest: true,
        },
      });

      if (!log) {
        res.status(404).json({ success: false, message: 'Attendance record not found.' });
        return;
      }

      if (log.studentId !== studentId && user.role !== Role.ADMIN) {
        res.status(403).json({
          success: false,
          message: 'You are not authorized to submit an excuse for another student.',
        });
        return;
      }

      if (log.status !== AttendanceStatus.ABSENT && log.status !== AttendanceStatus.CUT) {
        res.status(400).json({
          success: false,
          message: `Cannot submit excuse slip for status ${log.status}. Only ABSENT or CUT records are eligible.`,
        });
        return;
      }

      // Check 7-day submission window
      const sessionDate = log.session.startTime || log.createdAt;
      const daysElapsed = (Date.now() - new Date(sessionDate).getTime()) / (1000 * 60 * 60 * 24);
      if (daysElapsed > 7.05) {
        res.status(400).json({
          success: false,
          message: 'Excuse slips must be submitted within 7 days of the lecture/lab session date.',
        });
        return;
      }

      // Prevent duplicate excuse submissions
      if (log.excuseRequest) {
        res.status(409).json({
          success: false,
          message: `An excuse request has already been submitted for this session (Status: ${log.excuseRequest.status}).`,
        });
        return;
      }

      const documentUrl = req.file ? req.file.path.replace(/\\/g, '/') : null;
      const documentName = req.file ? req.file.originalname : null;

      const excuse = await prisma.excuseRequest.create({
        data: {
          studentId: log.studentId,
          attendanceLogId: log.id,
          reason: reason.trim(),
          documentUrl,
          documentName,
          status: 'PENDING',
        },
        include: {
          student: {
            select: { id: true, firstName: true, lastName: true, studentId: true, email: true },
          },
          attendanceLog: {
            include: {
              session: {
                include: { section: true },
              },
            },
          },
        },
      });

      res.status(201).json({
        success: true,
        message: 'Excuse request submitted successfully. Awaiting faculty review.',
        data: excuse,
      });
    } catch (err: any) {
      console.error('❌ Error submitting excuse request:', err);
      res.status(500).json({
        success: false,
        message: err.message || 'Failed to submit excuse request.',
      });
    }
  }

  /**
   * GET /api/v1/excuses/my
   * Returns all excuses submitted by the authenticated student
   */
  async getMyExcuses(req: AuthRequest, res: Response): Promise<void> {
    try {
      const studentId = req.user?.id;
      if (!studentId) {
        res.status(401).json({ success: false, message: 'Authentication required.' });
        return;
      }

      const excuses = await prisma.excuseRequest.findMany({
        where: { studentId },
        include: {
          attendanceLog: {
            include: {
              session: {
                include: {
                  section: true,
                },
              },
            },
          },
          reviewedBy: {
            select: { id: true, firstName: true, lastName: true, role: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      res.status(200).json({
        success: true,
        data: excuses,
      });
    } catch (err: any) {
      console.error('❌ Error retrieving student excuses:', err);
      res.status(500).json({
        success: false,
        message: err.message || 'Failed to retrieve excuse requests.',
      });
    }
  }

  /**
   * GET /api/v1/excuses/pending
   * Returns pending excuses for faculty's taught sections or all pending for admin
   */
  async getPendingExcuses(req: AuthRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ success: false, message: 'Authentication required.' });
        return;
      }

      const whereClause: any = { status: 'PENDING' };

      if (user.role === Role.FACULTY) {
        whereClause.attendanceLog = {
          session: {
            section: {
              facultyId: user.id,
            },
          },
        };
      }

      const pending = await prisma.excuseRequest.findMany({
        where: whereClause,
        include: {
          student: {
            select: { id: true, firstName: true, lastName: true, studentId: true, email: true },
          },
          attendanceLog: {
            include: {
              session: {
                include: {
                  section: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      res.status(200).json({
        success: true,
        data: pending,
      });
    } catch (err: any) {
      console.error('❌ Error retrieving pending excuses:', err);
      res.status(500).json({
        success: false,
        message: err.message || 'Failed to retrieve pending excuses.',
      });
    }
  }

  /**
   * PATCH /api/v1/excuses/:id/review
   * Faculty approves or rejects a student's excuse request
   */
  async reviewExcuse(req: AuthRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ success: false, message: 'Authentication required.' });
        return;
      }

      const excuseId = req.params.id as string;
      const { status, reviewNotes } = req.body;

      if (!['APPROVED', 'REJECTED'].includes(status)) {
        res.status(400).json({
          success: false,
          message: 'Review status must be either APPROVED or REJECTED.',
        });
        return;
      }

      const excuse = await prisma.excuseRequest.findUnique({
        where: { id: excuseId },
        include: {
          student: true,
          attendanceLog: {
            include: {
              session: {
                include: { section: true },
              },
            },
          },
        },
      });

      if (!excuse) {
        res.status(404).json({ success: false, message: 'Excuse request not found.' });
        return;
      }

      // Verify authorization: faculty must own the section or be an admin
      if (
        user.role === Role.FACULTY &&
        excuse.attendanceLog.session.section.facultyId !== user.id
      ) {
        res.status(403).json({
          success: false,
          message: 'You are not authorized to review excuses for this section.',
        });
        return;
      }

      const now = new Date();

      const updatedExcuse = await prisma.excuseRequest.update({
        where: { id: excuseId },
        data: {
          status,
          reviewNotes: reviewNotes || null,
          reviewedById: user.id,
          reviewedAt: now,
        },
        include: {
          reviewedBy: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      });

      // If approved, update AttendanceLog to EXCUSED with manual override details
      if (status === 'APPROVED') {
        const updatedLog = await prisma.attendanceLog.update({
          where: { id: excuse.attendanceLogId },
          data: {
            status: AttendanceStatus.EXCUSED,
            isManualOverride: true,
            overrideReason: `Excuse Approved: ${excuse.reason}`,
            overriddenById: user.id,
            overriddenAt: now,
          },
          include: { student: true },
        });

        // Only emit real-time live attendance update if this session is currently OPEN on the terminal
        if (excuse.attendanceLog.session.status === 'OPEN') {
          const activeSessionData = await sessionService.getActiveSession(
            excuse.attendanceLog.session.terminalId
          );

          emitAttendanceUpdated({
            sessionId: excuse.attendanceLog.sessionId,
            terminalId: excuse.attendanceLog.session.terminalId,
            studentId: excuse.studentId,
            studentNumber: excuse.student.studentId || 'N/A',
            studentName: `${excuse.student.firstName} ${excuse.student.lastName}`,
            status: AttendanceStatus.EXCUSED,
            authMethod: updatedLog.authMethod,
            tapTimestamp: updatedLog.tapTimestamp ? updatedLog.tapTimestamp.toISOString() : null,
            isManualOverride: true,
            overrideReason: updatedLog.overrideReason,
            stats: activeSessionData.stats,
            roster: activeSessionData.roster,
          });
        }
      } else if (status === 'REJECTED' && excuse.status === 'APPROVED') {
        // If an already-approved excuse is revoked/rejected, revert attendance to ABSENT
        await prisma.attendanceLog.update({
          where: { id: excuse.attendanceLogId },
          data: {
            status: AttendanceStatus.ABSENT,
            isManualOverride: true,
            overrideReason: `Excuse Rejected: ${reviewNotes || 'Revoked by faculty'}`,
            overriddenById: user.id,
            overriddenAt: now,
          },
        });
      }

      emitExcuseReviewed({
        excuseId: updatedExcuse.id,
        attendanceLogId: excuse.attendanceLogId,
        studentId: excuse.studentId,
        status,
        reviewedBy: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        reviewNotes: reviewNotes || null,
        reviewedAt: now.toISOString(),
      });

      res.status(200).json({
        success: true,
        message: `Excuse request ${status.toLowerCase()} successfully.`,
        data: updatedExcuse,
      });
    } catch (err: any) {
      console.error('❌ Error reviewing excuse request:', err);
      res.status(500).json({
        success: false,
        message: err.message || 'Failed to review excuse request.',
      });
    }
  }

  /**
   * GET /api/v1/excuses/:id/document
   * Protected download stream for attached excuse/medical documents
   */
  async downloadDocument(req: AuthRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ success: false, message: 'Authentication required.' });
        return;
      }

      const excuseId = req.params.id as string;
      const excuse = await prisma.excuseRequest.findUnique({
        where: { id: excuseId },
        include: {
          attendanceLog: {
            include: {
              session: {
                include: { section: true },
              },
            },
          },
        },
      });

      if (!excuse || !excuse.documentUrl) {
        res.status(404).json({ success: false, message: 'Excuse document not found.' });
        return;
      }

      // Check access: Student owner, Faculty teaching the section, or Admin
      const isOwner = excuse.studentId === user.id;
      const isSectionFaculty = excuse.attendanceLog.session.section.facultyId === user.id;
      const isAdmin = user.role === Role.ADMIN;

      if (!isOwner && !isSectionFaculty && !isAdmin) {
        res.status(403).json({
          success: false,
          message: 'Access denied: You are not authorized to view this medical document.',
        });
        return;
      }

      const uploadsRoot = path.resolve('uploads', 'excuses');
      const fullPath = path.resolve(excuse.documentUrl);

      // Path traversal security check
      if (!fullPath.startsWith(uploadsRoot)) {
        res.status(403).json({
          success: false,
          message: 'Access denied: Invalid document path.',
        });
        return;
      }

      if (!fs.existsSync(fullPath)) {
        res.status(404).json({
          success: false,
          message: 'File does not exist on disk.',
        });
        return;
      }

      res.download(fullPath, excuse.documentName || path.basename(fullPath));
    } catch (err: any) {
      console.error('❌ Error downloading excuse document:', err);
      res.status(500).json({
        success: false,
        message: err.message || 'Failed to download excuse document.',
      });
    }
  }
}

export const excuseController = new ExcuseController();
export default excuseController;
