import { Router } from 'express';
import { hardwareController } from '../controllers/hardware.controller.js';
import { hardwareAuth, hardwareOrJwtAuth } from '../middlewares/hardware.middleware.js';
import { requireAuth, requireRole } from '../middlewares/auth.middleware.js';
import { Role } from '@prisma/client';
import { hardwareTapLimiter, keypadOtpLimiter } from '../middlewares/rateLimiter.middleware.js';

const router = Router();

// Edge ESP32 endpoints guarded by hardware API key and rate limiters
router.post('/tap', hardwareAuth, hardwareTapLimiter, (req, res) => hardwareController.handleCardTap(req, res));
router.post('/otp', hardwareAuth, keypadOtpLimiter, (req, res) => hardwareController.handleKeypadOtp(req, res));
router.post('/select-section', hardwareOrJwtAuth, (req, res) => hardwareController.handleSelectSection(req, res));
router.post('/offline-sync', hardwareAuth, (req, res) => hardwareController.handleOfflineSync(req, res));
router.get('/status/:terminalId', hardwareOrJwtAuth, (req, res) => hardwareController.getTerminalStatus(req, res));
router.get('/last-scanned', requireAuth, requireRole(Role.ADMIN), (req, res) => hardwareController.getLastScanned(req, res));

// Admin live RFID enrollment mode session controls
router.post('/enrollment/start', requireAuth, requireRole(Role.ADMIN), (req, res) => hardwareController.startEnrollment(req, res));
router.post('/enrollment/stop', requireAuth, requireRole(Role.ADMIN), (req, res) => hardwareController.stopEnrollment(req, res));
router.get('/enrollment/status/:terminalId?', requireAuth, requireRole(Role.ADMIN, Role.FACULTY), (req, res) => hardwareController.getEnrollmentStatus(req, res));

export default router;
