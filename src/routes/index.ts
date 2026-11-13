import { Router } from 'express';
import hardwareRoutes from './hardware.routes.js';
import sessionRoutes from './session.routes.js';
import otpRoutes from './otp.routes.js';
import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import sectionRoutes from './section.routes.js';
import enrollmentRoutes from './enrollment.routes.js';
import analyticsRoutes from './analytics.routes.js';
import studentRoutes from './student.routes.js';
import prisma from '../config/prisma.js';

const router = Router();

router.use('/hardware', hardwareRoutes);
router.use('/sessions', sessionRoutes);
router.use('/otp', otpRoutes);
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/sections', sectionRoutes);
router.use('/enrollments', enrollmentRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/students', studentRoutes);

// Health check endpoint
router.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({
      status: 'ONLINE',
      framework: 'ORCHESTRA IoT Classroom Attendance Framework',
      database: 'connected',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(503).json({
      status: 'ERROR',
      framework: 'ORCHESTRA IoT Classroom Attendance Framework',
      database: 'disconnected',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      error: error?.message || 'Database connection failure',
    });
  }
});

export default router;
