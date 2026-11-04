import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../config/prisma.js';

const updateRfidSchema = z.object({
  rfidUid: z.string().min(1, 'RFID UID is required').max(32),
});

export class UserController {
  /**
   * GET /api/v1/users
   * Retrieve all users sorted by role and name
   */
  async getAllUsers(req: Request, res: Response): Promise<void> {
    try {
      const users = await prisma.user.findMany({
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
