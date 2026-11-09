import { Router } from 'express';
import hardwareRoutes from './hardware.routes.js';
import sessionRoutes from './session.routes.js';
import otpRoutes from './otp.routes.js';
import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import sectionRoutes from './section.routes.js';
import enrollmentRoutes from './enrollment.routes.js';
import analyticsRoutes from './analytics.routes.js';

const router = Router();

router.use('/hardware', hardwareRoutes);
router.use('/sessions', sessionRoutes);
router.use('/otp', otpRoutes);
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/sections', sectionRoutes);
router.use('/enrollments', enrollmentRoutes);
router.use('/analytics', analyticsRoutes);

// Health check endpoint
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ONLINE',
    framework: 'ORCHESTRA IoT Classroom Attendance Framework',
    timestamp: new Date().toISOString(),
  });
});

export default router;
