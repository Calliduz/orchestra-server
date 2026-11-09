import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Role } from '@prisma/client';
import prisma from '../config/prisma.js';

const updateRfidSchema = z.object({
  rfidUid: z.string().min(1, 'RFID UID is required').max(32),
});

const createUserSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  role: z.nativeEnum(Role, { errorMap: () => ({ message: 'Invalid role' }) }).default(Role.STUDENT),
  studentId: z.string().optional().nullable(),
  rfidUid: z.string().optional().nullable(),
  department: z.string().optional().nullable().default('College of Computer Studies'),
});

const updateUserSchema = z.object({
  email: z.string().email('Invalid email address').optional(),
  password: z.string().min(6, 'Password must be at least 6 characters').optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  role: z.nativeEnum(Role).optional(),
  studentId: z.string().optional().nullable(),
  rfidUid: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
});

export class UserController {
  /**
   * GET /api/v1/users
   * Retrieve all users with optional filtering (search, role)
   */
  async getAllUsers(req: Request, res: Response): Promise<void> {
    try {
      const { role, search } = req.query;

      const whereClause: any = {};

      if (role && typeof role === 'string' && Object.values(Role).includes(role as Role)) {
        whereClause.role = role as Role;
      }

      if (search && typeof search === 'string') {
        const query = search.trim();
        whereClause.OR = [
          { firstName: { contains: query, mode: 'insensitive' } },
          { lastName: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } },
          { studentId: { contains: query, mode: 'insensitive' } },
          { rfidUid: { contains: query, mode: 'insensitive' } },
        ];
      }

      const users = await prisma.user.findMany({
        where: whereClause,
        select: {
          id: true,
          studentId: true,
          firstName: true,
          lastName: true,
          email: true,
          role: true,
          rfidUid: true,
          department: true,
          createdAt: true,
          _count: {
            select: {
              enrollments: true,
              sectionsTaught: true,
            },
          },
        },
        orderBy: [
          { role: 'asc' },
          { lastName: 'asc' },
        ],
      });

      res.status(200).json({
        success: true,
        data: users,
      });
    } catch (err: any) {
      console.error('❌ Error fetching users:', err);
      res.status(500).json({
        success: false,
        message: err.message || 'Failed to fetch users',
      });
    }
  }

  /**
   * GET /api/v1/users/:id
   */
  async getUserById(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const user = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          studentId: true,
          firstName: true,
          lastName: true,
          email: true,
          role: true,
          rfidUid: true,
          department: true,
          createdAt: true,
          enrollments: {
            include: { section: true },
          },
          sectionsTaught: true,
        },
      });

      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      res.status(200).json({ success: true, data: user });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * POST /api/v1/users
   * Admin-only user registration (student or faculty with optional RFID badge)
   */
  async createUser(req: Request, res: Response): Promise<void> {
    try {
      const parsed = createUserSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: parsed.error.issues[0]?.message || 'Invalid user data',
        });
        return;
      }

      const { email, password, firstName, lastName, role, studentId, rfidUid, department } = parsed.data;

      // Check unique email
      const existingEmail = await prisma.user.findUnique({ where: { email } });
      if (existingEmail) {
        res.status(400).json({ success: false, message: 'A user with this email already exists.' });
        return;
      }

      // Check unique studentId if supplied
      if (studentId) {
        const existingStudentId = await prisma.user.findUnique({ where: { studentId } });
        if (existingStudentId) {
          res.status(400).json({ success: false, message: 'Student / Employee ID is already registered.' });
          return;
        }
      }

      // Clean RFID UID if supplied
      let cleanRfid: string | null = null;
      if (rfidUid && rfidUid.trim()) {
        cleanRfid = rfidUid.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        // Check if UID is already in use
        const existingRfid = await prisma.user.findUnique({ where: { rfidUid: cleanRfid } });
        if (existingRfid) {
          res.status(400).json({
            success: false,
            message: `RFID badge "${cleanRfid}" is already assigned to ${existingRfid.firstName} ${existingRfid.lastName}.`,
          });
          return;
        }
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          firstName,
          lastName,
          role,
          studentId: studentId || null,
          rfidUid: cleanRfid,
          department: department || 'College of Computer Studies',
        },
        select: {
          id: true,
          studentId: true,
          firstName: true,
          lastName: true,
          email: true,
          role: true,
          rfidUid: true,
          department: true,
          createdAt: true,
        },
      });

      res.status(201).json({
        success: true,
        message: `Successfully created ${user.role.toLowerCase()}: ${user.firstName} ${user.lastName}`,
        data: user,
      });
    } catch (err: any) {
      console.error('❌ Error creating user:', err);
      res.status(500).json({ success: false, message: err.message || 'Failed to create user' });
    }
  }

  /**
   * PUT /api/v1/users/:id
   * Admin-only user update
   */
  async updateUser(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const parsed = updateUserSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: parsed.error.issues[0]?.message || 'Invalid update payload',
        });
        return;
      }

      const updateData: any = {};
      const { email, password, firstName, lastName, role, studentId, rfidUid, department } = parsed.data;

      if (firstName !== undefined) updateData.firstName = firstName;
      if (lastName !== undefined) updateData.lastName = lastName;
      if (role !== undefined) updateData.role = role;
      if (department !== undefined) updateData.department = department;

      if (email !== undefined) {
        const existing = await prisma.user.findFirst({ where: { email, NOT: { id } } });
        if (existing) {
          res.status(400).json({ success: false, message: 'Email address already in use.' });
          return;
        }
        updateData.email = email;
      }

      if (studentId !== undefined) {
        if (studentId) {
          const existing = await prisma.user.findFirst({ where: { studentId, NOT: { id } } });
          if (existing) {
            res.status(400).json({ success: false, message: 'Student ID already in use.' });
            return;
          }
        }
        updateData.studentId = studentId;
      }

      if (rfidUid !== undefined) {
        if (rfidUid && rfidUid.trim()) {
          const clean = rfidUid.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
          const existing = await prisma.user.findFirst({ where: { rfidUid: clean, NOT: { id } } });
          if (existing) {
            res.status(400).json({
              success: false,
              message: `RFID badge "${clean}" is already assigned to ${existing.firstName} ${existing.lastName}.`,
            });
            return;
          }
          updateData.rfidUid = clean;
        } else {
          updateData.rfidUid = null;
        }
      }

      if (password) {
        updateData.password = await bcrypt.hash(password, 10);
      }

      const updated = await prisma.user.update({
        where: { id },
        data: updateData,
        select: {
          id: true,
          studentId: true,
          firstName: true,
          lastName: true,
          email: true,
          role: true,
          rfidUid: true,
          department: true,
          updatedAt: true,
        },
      });

      res.status(200).json({
        success: true,
        message: `Updated profile for ${updated.firstName} ${updated.lastName}`,
        data: updated,
      });
    } catch (err: any) {
      console.error('❌ Error updating user:', err);
      res.status(500).json({ success: false, message: err.message || 'Failed to update user' });
    }
  }

  /**
   * DELETE /api/v1/users/:id
   * Admin-only user deletion
   */
  async deleteUser(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      await prisma.user.delete({ where: { id } });

      res.status(200).json({
        success: true,
        message: `User ${user.firstName} ${user.lastName} successfully deleted.`,
      });
    } catch (err: any) {
      console.error('❌ Error deleting user:', err);
      res.status(500).json({ success: false, message: err.message || 'Failed to delete user' });
    }
  }

  /**
   * PATCH /api/v1/users/:id/rfid
   * Assign or update a user's physical RFID UID
   */
  async updateUserRfid(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const parsed = updateRfidSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: parsed.error.issues[0]?.message || 'Invalid RFID payload',
        });
        return;
      }

      const cleanRfid = parsed.data.rfidUid.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

      // Check if this RFID UID is already assigned to another user
      const existing = await prisma.user.findUnique({
        where: { rfidUid: cleanRfid },
      });

      if (existing && existing.id !== id) {
        // Disassociate previous user to avoid @@unique collision
        await prisma.user.update({
          where: { id: existing.id },
          data: { rfidUid: null },
        });
        console.log(`⚠️ Unassigned RFID UID ${cleanRfid} from previous owner: ${existing.firstName} ${existing.lastName}`);
      }

      const updated = await prisma.user.update({
        where: { id },
        data: { rfidUid: cleanRfid },
        select: {
          id: true,
          studentId: true,
          firstName: true,
          lastName: true,
          role: true,
          rfidUid: true,
        },
      });

      console.log(`✅ Assigned RFID UID ${cleanRfid} to [${updated.role}] ${updated.firstName} ${updated.lastName}`);

      res.status(200).json({
        success: true,
        message: `Successfully registered badge ${cleanRfid} to ${updated.firstName} ${updated.lastName}`,
        data: updated,
      });
    } catch (err: any) {
      console.error('❌ Error updating user RFID:', err);
      res.status(500).json({
        success: false,
        message: err.message || 'Failed to update RFID',
      });
    }
  }

  /**
   * DELETE /api/v1/users/:id/rfid
   * Unbind an RFID badge from a user
   */
  async removeUserRfid(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const updated = await prisma.user.update({
        where: { id },
        data: { rfidUid: null },
        select: {
          id: true,
          studentId: true,
          firstName: true,
          lastName: true,
          role: true,
          rfidUid: true,
        },
      });

      res.status(200).json({
        success: true,
        message: `Unbound RFID badge from ${updated.firstName} ${updated.lastName}`,
        data: updated,
      });
    } catch (err: any) {
      console.error('❌ Error removing user RFID:', err);
      res.status(500).json({
        success: false,
        message: err.message || 'Failed to remove RFID',
      });
    }
  }
}

export const userController = new UserController();
export default userController;
