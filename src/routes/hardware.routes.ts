import { Router } from 'express';
import { hardwareController } from '../controllers/hardware.controller.js';
import { hardwareAuth } from '../middlewares/hardware.middleware.js';
import { hardwareTapLimiter, keypadOtpLimiter } from '../middlewares/rateLimiter.middleware.js';

const router = Router();

// Edge ESP32 endpoints guarded by hardware API key and rate limiters
router.post('/tap', hardwareAuth, hardwareTapLimiter, (req, res) => hardwareController.handleCardTap(req, res));
router.post('/otp', hardwareAuth, keypadOtpLimiter, (req, res) => hardwareController.handleKeypadOtp(req, res));
router.get('/status/:terminalId', (req, res) => hardwareController.getTerminalStatus(req, res));

export default router;
