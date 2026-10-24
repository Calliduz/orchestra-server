import { Router } from 'express';
import { sessionController } from '../controllers/session.controller.js';

const router = Router();

router.get('/active/:terminalId', (req, res) => sessionController.getActiveSession(req, res));
router.patch('/:id/thresholds', (req, res) => sessionController.updateThresholds(req, res));
router.patch('/:id/override', (req, res) => sessionController.applyOverride(req, res));
router.post('/:id/close', (req, res) => sessionController.closeSession(req, res));
router.get('/:id/export/pdf', (req, res) => sessionController.downloadPdf(req, res));
router.get('/:id/export/csv', (req, res) => sessionController.downloadCsv(req, res));
router.get('/', (req, res) => sessionController.listSessions(req, res));

export default router;
