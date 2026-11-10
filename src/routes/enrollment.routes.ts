import { Router } from 'express';
import { enrollmentController } from '../controllers/enrollment.controller.js';
import { requireAuth, requireRole } from '../middlewares/auth.middleware.js';
import { Role } from '@prisma/client';

const router = Router();

// Section roster view (available to faculty & admin)
router.get('/section/:sectionId', (req, res) => enrollmentController.getEnrollmentsBySection(req, res));

// Admin-only enrollment mutations
router.post('/', requireAuth, requireRole(Role.ADMIN), (req, res) => enrollmentController.enrollStudent(req, res));
router.post('/bulk', requireAuth, requireRole(Role.ADMIN), (req, res) => enrollmentController.bulkEnroll(req, res));
router.post('/bulk-unenroll', requireAuth, requireRole(Role.ADMIN), (req, res) => enrollmentController.bulkUnenroll(req, res));
router.delete('/:studentId/:sectionId', requireAuth, requireRole(Role.ADMIN), (req, res) => enrollmentController.unenrollStudent(req, res));

export default router;

