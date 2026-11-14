import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Role } from '@prisma/client';
import prisma from '../config/prisma.js';

const updateRfidSchema = z.object({
  rfidUid: z.string().min(1, 'RFID UID is required').max(32),
});

const massDeleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, 'At least one user ID is required').max(200),
});

const bulkUserRowSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  email: z.string().email('Invalid email'),
  studentId: z.string().optional().nullable(),
  rfidUid: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  role: z.nativeEnum(Role).optional().default(Role.STUDENT),
  password: z.string().optional().nullable(),
});

const massCreateSchema = z.object({
  users: z.array(bulkUserRowSchema).min(1).max(500),
});

const createUserSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters').optional(),
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

      const rawPassword = password || (role === Role.STUDENT ? 'StudentPass123!' : 'Password123!');
      const hashedPassword = await bcrypt.hash(rawPassword, 10);

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
      if (err.code === 'P2025') {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }
      console.error('❌ Error updating user:', err);
      res.status(500).json({ success: false, message: err.message || 'Failed to update user' });
    }
  }

  /**
   * DELETE /api/v1/users/:id
   * Admin-only user deletion with cascade safety
   */
  async deleteUser(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const user = await prisma.user.findUnique({
        where: { id },
        include: {
          _count: {
            select: {
              enrollments: true,
              attendanceLogs: true,
              sectionsTaught: true,
              sessionsInstructed: true,
              otpCodes: true,
            },
          },
        },
      });
      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      // Prevent deletion of faculty who still own sections or active sessions
      if (user.role === Role.FACULTY || user.role === Role.ADMIN) {
        if (user._count.sectionsTaught > 0) {
          res.status(409).json({
            success: false,
            message: `Cannot delete ${user.firstName} ${user.lastName} — they are assigned to ${user._count.sectionsTaught} section(s). Reassign or delete those sections first.`,
          });
          return;
        }
        if (user._count.sessionsInstructed > 0) {
          res.status(409).json({
            success: false,
            message: `Cannot delete ${user.firstName} ${user.lastName} — they have ${user._count.sessionsInstructed} session record(s). Archive sessions first.`,
          });
          return;
        }
      }

      // For students: cascading delete will remove enrollments, attendance logs, and OTP codes
      await prisma.user.delete({ where: { id } });

      const cascaded: string[] = [];
      if (user._count.enrollments > 0) cascaded.push(`${user._count.enrollments} enrollment(s)`);
      if (user._count.attendanceLogs > 0) cascaded.push(`${user._count.attendanceLogs} attendance log(s)`);
      if (user._count.otpCodes > 0) cascaded.push(`${user._count.otpCodes} OTP code(s)`);

      res.status(200).json({
        success: true,
        message: `User ${user.firstName} ${user.lastName} successfully deleted.${cascaded.length > 0 ? ` Removed ${cascaded.join(', ')}.` : ''}`,
      });
    } catch (err: any) {
      console.error('❌ Error deleting user:', err);
      // Handle Prisma foreign key constraint error
      if (err.code === 'P2003') {
        res.status(409).json({
          success: false,
          message: 'Cannot delete this user — they have dependent records that prevent deletion. Remove their sections or sessions first.',
        });
        return;
      }
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

      // Atomically reassign RFID UID within a transaction to avoid unique collision and partial state
      const updated = await prisma.$transaction(async (tx) => {
        const existing = await tx.user.findUnique({
          where: { rfidUid: cleanRfid },
        });

        if (existing && existing.id !== id) {
          // Disassociate previous user to avoid @@unique collision
          await tx.user.update({
            where: { id: existing.id },
            data: { rfidUid: null },
          });
          console.log(`⚠️ Unassigned RFID UID ${cleanRfid} from previous owner: ${existing.firstName} ${existing.lastName}`);
        }

        return tx.user.update({
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
      });

      console.log(`✅ Assigned RFID UID ${cleanRfid} to [${updated.role}] ${updated.firstName} ${updated.lastName}`);

      res.status(200).json({
        success: true,
        message: `Successfully registered badge ${cleanRfid} to ${updated.firstName} ${updated.lastName}`,
        data: updated,
      });
    } catch (err: any) {
      if (err.code === 'P2025') {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }
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
      if (err.code === 'P2025') {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }
      console.error('❌ Error removing user RFID:', err);
      res.status(500).json({
        success: false,
        message: err.message || 'Failed to remove RFID',
      });
    }
  }
  /**
   * DELETE /api/v1/users/bulk
   * Admin-only: delete multiple users by ID array.
   * Students are cascade-deleted; faculty with sections/sessions are skipped.
   */
  async massDeleteUsers(req: Request, res: Response): Promise<void> {
    try {
      const parsed = massDeleteSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid payload' });
        return;
      }

      const { ids } = parsed.data;

      // Fetch users with relation counts to decide which can be deleted
      const users = await prisma.user.findMany({
        where: { id: { in: ids } },
        include: {
          _count: { select: { sectionsTaught: true, sessionsInstructed: true } },
        },
      });

      const skipped: { name: string; reason: string }[] = [];
      const toDeleteIds: string[] = [];

      for (const u of users) {
        const isProtected =
          (u.role === Role.FACULTY || u.role === Role.ADMIN) &&
          (u._count.sectionsTaught > 0 || u._count.sessionsInstructed > 0);

        if (isProtected) {
          skipped.push({
            name: `${u.firstName} ${u.lastName}`,
            reason: `has ${u._count.sectionsTaught} section(s) / ${u._count.sessionsInstructed} session(s)`,
          });
        } else {
          toDeleteIds.push(u.id);
        }
      }

      let deleted = 0;
      if (toDeleteIds.length > 0) {
        const result = await prisma.user.deleteMany({ where: { id: { in: toDeleteIds } } });
        deleted = result.count;
      }

      res.status(200).json({
        success: true,
        message: `Deleted ${deleted} user(s).${skipped.length > 0 ? ` Skipped ${skipped.length}: ${skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}` : ''}`,
        data: { deleted, skipped },
      });
    } catch (err: any) {
      console.error('❌ Mass delete error:', err);
      res.status(500).json({ success: false, message: err.message || 'Mass delete failed' });
    }
  }

  /**
   * POST /api/v1/users/bulk
   * Admin-only: create up to 500 users at once from a parsed array.
   * Returns per-row results so the UI can show which rows succeeded/failed.
   */
  async massCreateUsers(req: Request, res: Response): Promise<void> {
    try {
      const parsed = massCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Invalid payload' });
        return;
      }

      const rows = parsed.data.users;
      const results: { row: number; success: boolean; email: string; message?: string }[] = [];
      let created = 0;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          // Check duplicates
          const [existingEmail, existingStudentId, existingRfid] = await Promise.all([
            prisma.user.findUnique({ where: { email: row.email } }),
            row.studentId ? prisma.user.findUnique({ where: { studentId: row.studentId } }) : null,
            row.rfidUid ? prisma.user.findUnique({ where: { rfidUid: row.rfidUid.replace(/[^a-zA-Z0-9]/g, '').toUpperCase() } }) : null,
          ]);

          if (existingEmail) {
            results.push({ row: i + 1, success: false, email: row.email, message: 'Email already exists' });
            continue;
          }
          if (existingStudentId) {
            results.push({ row: i + 1, success: false, email: row.email, message: `Student ID "${row.studentId}" already in use` });
            continue;
          }
          if (existingRfid) {
            results.push({ row: i + 1, success: false, email: row.email, message: `RFID UID "${row.rfidUid}" already assigned` });
            continue;
          }

          const role = row.role ?? Role.STUDENT;
          const rawPassword = row.password || (role === Role.STUDENT ? 'StudentPass123!' : 'Password123!');
          const hashedPassword = await bcrypt.hash(rawPassword, 10);
          const cleanRfid = row.rfidUid ? row.rfidUid.replace(/[^a-zA-Z0-9]/g, '').toUpperCase() : null;

          await prisma.user.create({
            data: {
              email: row.email,
              password: hashedPassword,
              firstName: row.firstName,
              lastName: row.lastName,
              role,
              studentId: row.studentId || null,
              rfidUid: cleanRfid || null,
              department: row.department || 'College of Computer Studies',
            },
          });

          results.push({ row: i + 1, success: true, email: row.email });
          created++;
        } catch (rowErr: any) {
          results.push({ row: i + 1, success: false, email: row.email, message: rowErr.message });
        }
      }

      res.status(201).json({
        success: true,
        message: `Created ${created} of ${rows.length} user(s).`,
        data: { created, failed: rows.length - created, results },
      });
    } catch (err: any) {
      console.error('❌ Mass create error:', err);
      res.status(500).json({ success: false, message: err.message || 'Mass create failed' });
    }
  }
}

export const userController = new UserController();
export default userController;
