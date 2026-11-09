import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../config/prisma.js';

const enrollSingleSchema = z.object({
  studentId: z.string().min(1, 'Student ID is required'),
  sectionId: z.string().min(1, 'Section ID is required'),
});

const enrollBulkSchema = z.object({
  studentIds: z.array(z.string().min(1)).min(1, 'At least one student is required'),
  sectionId: z.string().min(1, 'Section ID is required'),
});

export class EnrollmentController {
  /**
   * GET /api/v1/enrollments/section/:sectionId
   * Retrieve all students enrolled in a specific section
   */
  async getEnrollmentsBySection(req: Request, res: Response): Promise<void> {
    try {
      const sectionId = req.params.sectionId as string;
      const enrollments = await prisma.enrollment.findMany({
        where: { sectionId },
        include: {
          student: {
            select: {
              id: true,
              studentId: true,
              firstName: true,
              lastName: true,
              email: true,
              rfidUid: true,
              department: true,
            },
          },
        },
        orderBy: { student: { lastName: 'asc' } },
      });

      res.status(200).json({ success: true, data: enrollments });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * POST /api/v1/enrollments
   * Admin-only: Enroll a single student in a section
   */
  async enrollStudent(req: Request, res: Response): Promise<void> {
    try {
      const parsed = enrollSingleSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: parsed.error.issues[0]?.message || 'Invalid enrollment payload',
        });
        return;
      }

      const { studentId, sectionId } = parsed.data;

      // Locate user by primary UUID or student identifier
      const student = await prisma.user.findFirst({
        where: { OR: [{ id: studentId }, { studentId }] },
      });

      if (!student) {
        res.status(404).json({ success: false, message: 'Student record not found.' });
        return;
      }

      const section = await prisma.section.findUnique({ where: { id: sectionId } });
      if (!section) {
        res.status(404).json({ success: false, message: 'Section not found.' });
        return;
      }

      // Check existing enrollment
      const existing = await prisma.enrollment.findUnique({
        where: {
          studentId_sectionId: {
            studentId: student.id,
            sectionId: section.id,
          },
        },
      });

      if (existing) {
        res.status(400).json({
          success: false,
          message: `${student.firstName} ${student.lastName} is already enrolled in ${section.sectionCode}.`,
        });
        return;
      }

      const enrollment = await prisma.enrollment.create({
        data: {
          studentId: student.id,
          sectionId: section.id,
        },
        include: {
          student: true,
          section: true,
        },
      });

      res.status(201).json({
        success: true,
        message: `Successfully enrolled ${student.firstName} ${student.lastName} into ${section.sectionCode}`,
        data: enrollment,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * POST /api/v1/enrollments/bulk
   * Admin-only: Bulk enroll students into a section
   */
  async bulkEnroll(req: Request, res: Response): Promise<void> {
    try {
      const parsed = enrollBulkSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: parsed.error.issues[0]?.message || 'Invalid bulk enrollment payload',
        });
        return;
      }

      const { studentIds, sectionId } = parsed.data;
      const section = await prisma.section.findUnique({ where: { id: sectionId } });
      if (!section) {
        res.status(404).json({ success: false, message: 'Section not found.' });
        return;
      }

      let enrolledCount = 0;
      for (const sId of studentIds) {
        const student = await prisma.user.findFirst({
          where: { OR: [{ id: sId }, { studentId: sId }] },
        });

        if (student) {
          try {
            await prisma.enrollment.upsert({
              where: {
                studentId_sectionId: {
                  studentId: student.id,
                  sectionId: section.id,
                },
              },
              update: {},
              create: {
                studentId: student.id,
                sectionId: section.id,
              },
            });
            enrolledCount++;
          } catch {
            // ignore duplicate errors in bulk loop
          }
        }
      }

      res.status(200).json({
        success: true,
        message: `Enrolled ${enrolledCount} students into ${section.sectionCode}.`,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * DELETE /api/v1/enrollments/:studentId/:sectionId
   * Admin-only: Unenroll student from section
   */
  async unenrollStudent(req: Request, res: Response): Promise<void> {
    try {
      const studentId = req.params.studentId as string;
      const sectionId = req.params.sectionId as string;

      const student = await prisma.user.findFirst({
        where: { OR: [{ id: studentId }, { studentId }] },
      });

      if (!student) {
        res.status(404).json({ success: false, message: 'Student record not found.' });
        return;
      }

      await prisma.enrollment.deleteMany({
        where: {
          studentId: student.id,
          sectionId,
        },
      });

      res.status(200).json({
        success: true,
        message: `Unenrolled student ${student.firstName} ${student.lastName} from section.`,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
}

export const enrollmentController = new EnrollmentController();
export default enrollmentController;
