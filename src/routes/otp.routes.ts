import { Router } from 'express';
import { otpController } from '../controllers/otp.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { otpRequestLimiter } from '../middlewares/rateLimiter.middleware.js';

const router = Router();

router.post('/request', requireAuth, otpRequestLimiter, (req, res) => otpController.requestOtp(req, res));

export default router;
