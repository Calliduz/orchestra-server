import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import prisma from '../config/prisma.js';
import { env } from '../config/env.js';
import { AuthRequest } from '../middlewares/auth.middleware.js';

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export class AuthController {
  /**
   * POST /api/v1/auth/login
   */
  async login(req: Request, res: Response): Promise<void> {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: parsed.error.issues[0]?.message || 'Invalid credentials format',
        });
        return;
      }

      const { email, password } = parsed.data;

      const user = await prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        res.status(401).json({ success: false, message: 'Invalid email or password.' });
        return;
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        res.status(401).json({ success: false, message: 'Invalid email or password.' });
        return;
      }

      const token = jwt.sign(
        {
          id: user.id,
          email: user.email,
          role: user.role,
          firstName: user.firstName,
          lastName: user.lastName,
        },
        env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.status(200).json({
        success: true,
        message: 'Login successful',
        data: {
          token,
          user: {
            id: user.id,
            email: user.email,
            role: user.role,
            firstName: user.firstName,
            lastName: user.lastName,
            rfidUid: user.rfidUid,
            department: user.department,
          },
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message || 'Login failed' });
    }
  }

  /**
   * GET /api/v1/auth/me
   */
  async getProfile(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, message: 'Not authenticated' });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          id: true,
          email: true,
          studentId: true,
          firstName: true,
          lastName: true,
          role: true,
          rfidUid: true,
          department: true,
          createdAt: true,
        },
      });

      res.status(200).json({ success: true, data: user });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
}

export const authController = new AuthController();
export default authController;
