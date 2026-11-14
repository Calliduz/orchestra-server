import { Router } from 'express';
import multer from 'multer';
import { bulkImportController } from '../controllers/bulk-import.controller.js';
import { requireAuth, requireRole } from '../middlewares/auth.middleware.js';
import { Role } from '@prisma/client';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

// Bulk CSV onboarding endpoints restricted to Administrator role
router.post(
  '/validate',
  requireAuth,
  requireRole(Role.ADMIN),
  upload.single('file'),
  (req, res) => bulkImportController.validateCsv(req, res)
);

router.post(
  '/commit',
  requireAuth,
  requireRole(Role.ADMIN),
  (req, res) => bulkImportController.commitCsv(req, res)
);

export default router;
