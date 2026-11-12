import { Router } from 'express';
import { studentController } from '../controllers/student.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

const router = Router();

// Authenticated student attendance history & KPI summary
router.get('/my-attendance', requireAuth, (req, res) => studentController.getMyAttendance(req, res));

export default router;
