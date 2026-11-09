import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../config/prisma.js';
import { AuthRequest } from '../middlewares/auth.middleware.js';
import { Role } from '@prisma/client';

const createSectionSchema = z.object({
  sectionCode: z.string().min(1, 'Section code is required (e.g. AR101-BSIT3A)'),
  courseName: z.string().min(1, 'Course name is required'),
  roomNumber: z.string().min(1, 'Room number is required (e.g. LAB-304)'),
  terminalId: z.string().min(1, 'Terminal ID is required (e.g. TERM-CL304)'),
  facultyId: z.string().uuid('Valid faculty ID is required'),
  defaultLateThresholdMins: z.number().int().min(1).default(15),
  defaultCutThresholdMins: z.number().int().min(2).default(45),
});

const updateSectionSchema = z.object({
  sectionCode: z.string().min(1).optional(),
  courseName: z.string().min(1).optional(),
  roomNumber: z.string().min(1).optional(),
  terminalId: z.string().min(1).optional(),
  facultyId: z.string().uuid().optional(),
  defaultLateThresholdMins: z.number().int().min(1).optional(),
  defaultCutThresholdMins: z.number().int().min(2).optional(),
});

export class SectionController {
  /**
   * GET /api/v1/sections
   * Retrieve all sections with metadata & enrollment counts
   */
  async getAllSections(req: Request, res: Response): Promise<void> {
    try {
      const sections = await prisma.section.findMany({
        include: {
          faculty: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          _count: {
            select: {
              enrollments: true,
              sessions: true,
            },
          },
        },
        orderBy: { sectionCode: 'asc' },
      });

      res.status(200).json({ success: true, data: sections });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * GET /api/v1/sections/my
   * Sections instructed by the authenticated faculty member
   */
  async getMySections(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return;
      }

      // If user is ADMIN, return all sections; if FACULTY, return sections assigned to them
      const whereClause = req.user.role === Role.ADMIN ? {} : { facultyId: req.user.id };

      const sections = await prisma.section.findMany({
        where: whereClause,
        include: {
          faculty: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          _count: {
            select: {
              enrollments: true,
              sessions: true,
            },
          },
          sessions: {
            where: { status: 'OPEN' },
            select: { id: true, terminalId: true, startTime: true },
          },
        },
        orderBy: { sectionCode: 'asc' },
      });

      res.status(200).json({ success: true, data: sections });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * GET /api/v1/sections/:id
   * Detail of a single section including enrolled student roster
   */
  async getSectionById(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const section = await prisma.section.findUnique({
        where: { id },
        include: {
          faculty: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          enrollments: {
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
          },
          sessions: {
            take: 10,
            orderBy: { startTime: 'desc' },
            include: {
              _count: { select: { attendanceLogs: true } },
            },
          },
        },
      });

      if (!section) {
        res.status(404).json({ success: false, message: 'Section not found' });
        return;
      }

      res.status(200).json({ success: true, data: section });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * POST /api/v1/sections
   * Admin-only section creation
   */
  async createSection(req: Request, res: Response): Promise<void> {
    try {
      const parsed = createSectionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: parsed.error.issues[0]?.message || 'Invalid section payload',
        });
        return;
      }

      const { sectionCode, courseName, roomNumber, terminalId, facultyId, defaultLateThresholdMins, defaultCutThresholdMins } = parsed.data;

      const existing = await prisma.section.findUnique({ where: { sectionCode } });
      if (existing) {
        res.status(400).json({ success: false, message: `Section code "${sectionCode}" already exists.` });
        return;
      }

      const facultyUser = await prisma.user.findUnique({ where: { id: facultyId } });
      if (!facultyUser || (facultyUser.role !== Role.FACULTY && facultyUser.role !== Role.ADMIN)) {
        res.status(400).json({ success: false, message: 'Assigned user must have FACULTY or ADMIN role.' });
        return;
      }

      const section = await prisma.section.create({
        data: {
          sectionCode,
          courseName,
          roomNumber,
          terminalId,
          facultyId,
          defaultLateThresholdMins,
          defaultCutThresholdMins,
        },
        include: {
          faculty: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      });

      res.status(201).json({
        success: true,
        message: `Successfully created section ${section.sectionCode}`,
        data: section,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message || 'Failed to create section' });
    }
  }

  /**
   * PUT /api/v1/sections/:id
   * Admin-only section update
   */
  async updateSection(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const parsed = updateSectionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: parsed.error.issues[0]?.message || 'Invalid update payload',
        });
        return;
      }

      if (parsed.data.sectionCode) {
        const existing = await prisma.section.findFirst({
          where: { sectionCode: parsed.data.sectionCode, NOT: { id } },
        });
        if (existing) {
          res.status(400).json({ success: false, message: 'Section code already in use.' });
          return;
        }
      }

      if (parsed.data.facultyId) {
        const facultyUser = await prisma.user.findUnique({ where: { id: parsed.data.facultyId } });
        if (!facultyUser || (facultyUser.role !== Role.FACULTY && facultyUser.role !== Role.ADMIN)) {
          res.status(400).json({ success: false, message: 'Assigned user must have FACULTY or ADMIN role.' });
          return;
        }
      }

      const updated = await prisma.section.update({
        where: { id },
        data: parsed.data,
        include: {
          faculty: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      });

      res.status(200).json({
        success: true,
        message: `Section ${updated.sectionCode} updated successfully.`,
        data: updated,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message || 'Failed to update section' });
    }
  }

  /**
   * DELETE /api/v1/sections/:id
   * Admin-only section deletion
   */
  async deleteSection(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const section = await prisma.section.findUnique({ where: { id } });
      if (!section) {
        res.status(404).json({ success: false, message: 'Section not found' });
        return;
      }

      await prisma.section.delete({ where: { id } });

      res.status(200).json({
        success: true,
        message: `Section ${section.sectionCode} deleted successfully.`,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message || 'Failed to delete section' });
    }
  }
}

export const sectionController = new SectionController();
export default sectionController;

