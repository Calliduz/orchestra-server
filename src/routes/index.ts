import { Router } from 'express';
import hardwareRoutes from './hardware.routes.js';
import sessionRoutes from './session.routes.js';
import otpRoutes from './otp.routes.js';
import authRoutes from './auth.routes.js';

const router = Router();

router.use('/hardware', hardwareRoutes);
router.use('/sessions', sessionRoutes);
router.use('/otp', otpRoutes);
router.use('/auth', authRoutes);

// Health check endpoint
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ONLINE',
    framework: 'ORCHESTRA IoT Classroom Attendance Framework',
    timestamp: new Date().toISOString(),
  });
});

export default router;
