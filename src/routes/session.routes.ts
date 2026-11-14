import { Router } from 'express';
import { sessionController } from '../controllers/session.controller.js';
import { requireAuth, requireRole } from '../middlewares/auth.middleware.js';
import { Role } from '@prisma/client';

const router = Router();

// Active terminal session
router.get('/active/:terminalId', (req, res) => sessionController.getActiveSession(req, res));

// Faculty's personal session history
router.get('/my', requireAuth, (req, res) => sessionController.getMySessions(req, res));

// List sessions with query filters
router.get('/', requireAuth, requireRole(Role.ADMIN, Role.FACULTY), (req, res) => sessionController.listSessions(req, res));

// Session detail by ID
router.get('/:id', requireAuth, (req, res) => sessionController.getSessionDetail(req, res));

// Session controls
router.post('/start', requireAuth, requireRole(Role.FACULTY, Role.ADMIN), (req, res) => sessionController.startSession(req, res));
router.patch('/:id/thresholds', requireAuth, requireRole(Role.FACULTY, Role.ADMIN), (req, res) => sessionController.updateThresholds(req, res));
router.patch('/:id/override', requireAuth, requireRole(Role.FACULTY, Role.ADMIN), (req, res) => sessionController.applyOverride(req, res));
router.post('/:id/close', requireAuth, requireRole(Role.FACULTY, Role.ADMIN), (req, res) => sessionController.closeSession(req, res));

// Export & Reports
router.get('/:id/export/pdf', requireAuth, requireRole(Role.ADMIN, Role.FACULTY), (req, res) => sessionController.downloadPdf(req, res));
router.get('/:id/export/institutional-pdf', requireAuth, requireRole(Role.ADMIN, Role.FACULTY), (req, res) => sessionController.downloadInstitutionalPdf(req, res));
router.get('/:id/export/csv', requireAuth, requireRole(Role.ADMIN, Role.FACULTY), (req, res) => sessionController.downloadCsv(req, res));
router.get('/:id/export/canvas', requireAuth, requireRole(Role.ADMIN, Role.FACULTY), (req, res) => sessionController.downloadCanvasCsv(req, res));
router.get('/:id/export/moodle', requireAuth, requireRole(Role.ADMIN, Role.FACULTY), (req, res) => sessionController.downloadMoodleCsv(req, res));
router.get('/:id/export/xlsx', requireAuth, requireRole(Role.ADMIN, Role.FACULTY), (req, res) => sessionController.downloadExcel(req, res));
router.post('/:id/email-report', requireAuth, requireRole(Role.FACULTY, Role.ADMIN), (req, res) => sessionController.emailReport(req, res));

export default router;
