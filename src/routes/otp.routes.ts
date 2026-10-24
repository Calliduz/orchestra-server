import { Router } from 'express';
import { otpController } from '../controllers/otp.controller.js';

const router = Router();

router.post('/request', (req, res) => otpController.requestOtp(req, res));

export default router;
