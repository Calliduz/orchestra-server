import { Router } from 'express';
import { hardwareController } from '../controllers/hardware.controller.js';
import { hardwareAuth } from '../middlewares/hardware.middleware.js';

const router = Router();

// Edge ESP32 endpoints guarded by hardware API key
router.post('/tap', hardwareAuth, (req, res) => hardwareController.handleCardTap(req, res));
router.post('/otp', hardwareAuth, (req, res) => hardwareController.handleKeypadOtp(req, res));
router.get('/status/:terminalId', (req, res) => hardwareController.getTerminalStatus(req, res));

export default router;
