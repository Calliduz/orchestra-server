import { Response } from 'express';
import { AttendanceStatus } from '@prisma/client';
import prisma from '../config/prisma.js';
import { AuthRequest } from '../middlewares/auth.middleware.js';

export class StudentController {
  /**
   * GET /api/v1/students/my-attendance
   * Returns personal attendance ledger and calculated punctuality KPIs for authenticated student
   */
  async getMyAttendance(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return;
      }

      const studentId = req.user.id;

      // Locate student profile
      const student = await prisma.user.findUnique({
        where: { id: studentId },
        select: {
          id: true,
          studentId: true,
          firstName: true,
          lastName: true,
          email: true,
          department: true,
        },
      });

      if (!student) {
        res.status(404).json({ success: false, message: 'Student profile not found' });
        return;
      }

      // Query historical attendance logs with course section and faculty context
      const logs = await prisma.attendanceLog.findMany({
        where: { studentId },
        include: {
          session: {
            include: {
              section: true,
              faculty: {
                select: { id: true, firstName: true, lastName: true, email: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      // Calculate KPI statistics
      const total = logs.length;
      let present = 0;
      let late = 0;
      let excused = 0;
      let absent = 0;

      for (const log of logs) {
        switch (log.status) {
          case AttendanceStatus.PRESENT:
            present++;
            break;
          case AttendanceStatus.LATE:
            late++;
            break;
          case AttendanceStatus.EXCUSED:
            excused++;
            break;
          case AttendanceStatus.ABSENT:
          case AttendanceStatus.CUT:
            absent++;
            break;
        }
      }

      const attendedCount = present + late + excused;
      const rate = total > 0 ? Number(((attendedCount / total) * 100).toFixed(1)) : 100.0;

      const formattedLogs = logs.map((log) => ({
        id: log.id,
        session: {
          id: log.session.id,
          courseCode: log.session.section.sectionCode,
          courseName: log.session.section.courseName,
          room: log.session.section.roomNumber,
          roomNumber: log.session.section.roomNumber,
          sectionCode: log.session.section.sectionCode,
          facultyName: `${log.session.faculty.firstName} ${log.session.faculty.lastName}`,
        },
        timestamp: (log.tapTimestamp || log.createdAt).toISOString(),
        status: log.status,
        authMethod: log.authMethod,
        isManualOverride: log.isManualOverride,
        overrideReason: log.overrideReason,
      }));

      res.status(200).json({
        success: true,
        data: {
          student: {
            id: student.id,
            studentId: student.studentId || '',
            name: `${student.firstName} ${student.lastName}`,
            firstName: student.firstName,
            lastName: student.lastName,
            email: student.email,
            department: student.department || 'College of Computer Studies',
          },
          kpi: {
            total,
            present,
            late,
            excused,
            absent,
            rate,
          },
          logs: formattedLogs,
        },
      });
    } catch (err: any) {
      console.error('❌ Error fetching student attendance history:', err);
      res.status(500).json({ success: false, message: err.message || 'Internal server error' });
    }
  }
}

export const studentController = new StudentController();
export default studentController;
