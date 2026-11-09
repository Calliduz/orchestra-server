import { Router } from 'express';
import { analyticsController } from '../controllers/analytics.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(requireAuth);

router.get('/faculty-summary', (req, res) => analyticsController.getFacultySummary(req, res));
router.get('/attendance-trends', (req, res) => analyticsController.getAttendanceTrends(req, res));
router.get('/student-punctuality', (req, res) => analyticsController.getStudentPunctuality(req, res));

export default router;

