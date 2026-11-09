import { Response } from 'express';
import prisma from '../config/prisma.js';
import { AuthRequest } from '../middlewares/auth.middleware.js';
import { AttendanceStatus, Role, SessionStatus } from '@prisma/client';

export class AnalyticsController {
  /**
   * GET /api/v1/analytics/faculty-summary
   * Aggregated KPIs and metrics for the authenticated faculty
   */
  async getFacultySummary(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return;
      }

      const facultyId = req.user.role === Role.ADMIN && req.query.facultyId
        ? (req.query.facultyId as string)
        : req.user.id;

      // 1. Get sections (if ADMIN without specific facultyId, get all sections)
      const sectionFilter: any = (req.user.role === Role.ADMIN && !req.query.facultyId) ? {} : { facultyId };
      const sections = await prisma.section.findMany({
        where: sectionFilter,
        select: { id: true, sectionCode: true },
      });
      const sectionIds = sections.map((s) => s.id);

      // 2. Total unique enrolled students
      const enrollments = await prisma.enrollment.findMany({
        where: { sectionId: { in: sectionIds } },
        select: { studentId: true },
      });
      const uniqueStudentIds = new Set(enrollments.map((e) => e.studentId));

      // 3. Sessions conducted (if ADMIN without specific facultyId, get all closed sessions)
      const sessionFilter: any = { status: SessionStatus.CLOSED };
      if (req.user.role !== Role.ADMIN || req.query.facultyId) {
        sessionFilter.facultyId = facultyId;
      }
      const sessions = await prisma.session.findMany({
        where: sessionFilter,
        include: {
          attendanceLogs: true,
        },
      });

      let totalLogs = 0;
      let presentCount = 0;
      let lateCount = 0;
      let cutCount = 0;
      let absentCount = 0;
      let excusedCount = 0;

      sessions.forEach((s) => {
        s.attendanceLogs.forEach((log) => {
          totalLogs++;
          if (log.status === AttendanceStatus.PRESENT) presentCount++;
          else if (log.status === AttendanceStatus.LATE) lateCount++;
          else if (log.status === AttendanceStatus.CUT) cutCount++;
          else if (log.status === AttendanceStatus.ABSENT) absentCount++;
          else if (log.status === AttendanceStatus.EXCUSED) excusedCount++;
        });
      });

      const attendedCount = presentCount + lateCount + excusedCount;
      const avgAttendanceRate = totalLogs > 0 ? ((attendedCount / totalLogs) * 100).toFixed(1) : '0';
      const tardinessRate = totalLogs > 0 ? ((lateCount / totalLogs) * 100).toFixed(1) : '0';
      const cutRate = totalLogs > 0 ? ((cutCount / totalLogs) * 100).toFixed(1) : '0';
      const absenceRate = totalLogs > 0 ? ((absentCount / totalLogs) * 100).toFixed(1) : '0';

      res.status(200).json({
        success: true,
        data: {
          totalClassrooms: sections.length,
          totalStudentsEnrolled: uniqueStudentIds.size,
          totalSessionsConducted: sessions.length,
          avgAttendanceRate: parseFloat(avgAttendanceRate),
          tardinessRate: parseFloat(tardinessRate),
          cutRate: parseFloat(cutRate),
          absenceRate: parseFloat(absenceRate),
          distribution: {
            present: presentCount,
            late: lateCount,
            cut: cutCount,
            absent: absentCount,
            excused: excusedCount,
          },
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * GET /api/v1/analytics/attendance-trends
   * Time-series session attendance for line & bar charts
   */
  async getAttendanceTrends(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return;
      }

      const facultyId = req.user.role === Role.ADMIN && req.query.facultyId
        ? (req.query.facultyId as string)
        : req.user.id;

      const { sectionId } = req.query;
      const whereClause: any = {
        status: SessionStatus.CLOSED,
      };

      if (req.user.role !== Role.ADMIN || req.query.facultyId) {
        whereClause.facultyId = facultyId;
      }

      if (sectionId && typeof sectionId === 'string') {
        whereClause.sectionId = sectionId;
      }

      const sessions = await prisma.session.findMany({
        where: whereClause,
        take: 20,
        orderBy: { startTime: 'asc' },
        include: {
          section: true,
          attendanceLogs: true,
          _count: {
            select: { attendanceLogs: true },
          },
        },
      });

      const trends = sessions.map((session) => {
        const present = session.attendanceLogs.filter((l) => l.status === AttendanceStatus.PRESENT).length;
        const late = session.attendanceLogs.filter((l) => l.status === AttendanceStatus.LATE).length;
        const cut = session.attendanceLogs.filter((l) => l.status === AttendanceStatus.CUT).length;
        const absent = session.attendanceLogs.filter((l) => l.status === AttendanceStatus.ABSENT).length;
        const excused = session.attendanceLogs.filter((l) => l.status === AttendanceStatus.EXCUSED).length;
        const total = session.attendanceLogs.length;
        const rate = total > 0 ? Math.round(((present + late + excused) / total) * 100) : 0;

        const dateStr = new Date(session.startTime).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        });
        const timeStr = new Date(session.startTime).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });

        return {
          sessionId: session.id,
          label: `${dateStr} (${session.section.sectionCode})`,
          shortDate: dateStr,
          timeStr,
          sectionCode: session.section.sectionCode,
          present,
          late,
          cut,
          absent,
          excused,
          total,
          attendanceRate: rate,
        };
      });

      res.status(200).json({ success: true, data: trends });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * GET /api/v1/analytics/student-punctuality
   * Per-student punctuality & tardiness tracking
   */
  async getStudentPunctuality(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return;
      }

      const facultyId = req.user.role === Role.ADMIN && req.query.facultyId
        ? (req.query.facultyId as string)
        : req.user.id;

      const { sectionId } = req.query;

      // Find faculty sections (or all sections if ADMIN without specific facultyId)
      const sectionFilter: any = (req.user.role === Role.ADMIN && !req.query.facultyId) ? {} : { facultyId };
      if (sectionId && typeof sectionId === 'string') {
        sectionFilter.id = sectionId;
      }
      const sections = await prisma.section.findMany({
        where: sectionFilter,
        select: { id: true, sectionCode: true },
      });
      const sectionIds = sections.map((s) => s.id);

      // Find enrolled students
      const enrollments = await prisma.enrollment.findMany({
        where: { sectionId: { in: sectionIds } },
        include: {
          student: true,
          section: true,
        },
      });

      // Find all attendance logs for sessions of these sections
      const logs = await prisma.attendanceLog.findMany({
        where: {
          session: {
            sectionId: { in: sectionIds },
            status: SessionStatus.CLOSED,
          },
        },
        include: { session: true },
      });

      const studentStatsMap = new Map<string, any>();

      enrollments.forEach((enr) => {
        const student = enr.student;
        if (!studentStatsMap.has(student.id)) {
          studentStatsMap.set(student.id, {
            id: student.id,
            studentNumber: student.studentId || 'N/A',
            fullName: `${student.lastName}, ${student.firstName}`,
            email: student.email,
            rfidUid: student.rfidUid,
            sections: [enr.section.sectionCode],
            totalSessions: 0,
            presentCount: 0,
            lateCount: 0,
            cutCount: 0,
            absentCount: 0,
            excusedCount: 0,
          });
        } else {
          studentStatsMap.get(student.id).sections.push(enr.section.sectionCode);
        }
      });

      logs.forEach((log) => {
        const entry = studentStatsMap.get(log.studentId);
        if (entry) {
          entry.totalSessions++;
          if (log.status === AttendanceStatus.PRESENT) entry.presentCount++;
          else if (log.status === AttendanceStatus.LATE) entry.lateCount++;
          else if (log.status === AttendanceStatus.CUT) entry.cutCount++;
          else if (log.status === AttendanceStatus.ABSENT) entry.absentCount++;
          else if (log.status === AttendanceStatus.EXCUSED) entry.excusedCount++;
        }
      });

      const results = Array.from(studentStatsMap.values()).map((s) => {
        const attended = s.presentCount + s.lateCount + s.excusedCount;
        const rate = s.totalSessions > 0 ? Math.round((attended / s.totalSessions) * 100) : 0;
        return {
          ...s,
          sections: s.sections.join(', '),
          attendanceRate: rate,
        };
      });

      // Sort by late count descending (tardiness ranking)
      results.sort((a, b) => b.lateCount - a.lateCount || b.absentCount - a.absentCount);

      res.status(200).json({ success: true, data: results });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
}

export const analyticsController = new AnalyticsController();
export default analyticsController;

