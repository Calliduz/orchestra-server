import { Router } from 'express';
import { sessionController } from '../controllers/session.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

const router = Router();

// Active terminal session
router.get('/active/:terminalId', (req, res) => sessionController.getActiveSession(req, res));

// Faculty's personal session history
router.get('/my', requireAuth, (req, res) => sessionController.getMySessions(req, res));

// List sessions with query filters
router.get('/', (req, res) => sessionController.listSessions(req, res));

// Session detail by ID
router.get('/:id', requireAuth, (req, res) => sessionController.getSessionDetail(req, res));

// Session controls
router.post('/start', requireAuth, (req, res) => sessionController.startSession(req, res));
router.patch('/:id/thresholds', requireAuth, (req, res) => sessionController.updateThresholds(req, res));
router.patch('/:id/override', requireAuth, (req, res) => sessionController.applyOverride(req, res));
router.post('/:id/close', requireAuth, (req, res) => sessionController.closeSession(req, res));

// Export & Reports
router.get('/:id/export/pdf', (req, res) => sessionController.downloadPdf(req, res));
router.get('/:id/export/csv', (req, res) => sessionController.downloadCsv(req, res));
router.get('/:id/export/xlsx', (req, res) => sessionController.downloadExcel(req, res));
router.post('/:id/email-report', requireAuth, (req, res) => sessionController.emailReport(req, res));

export default router;
