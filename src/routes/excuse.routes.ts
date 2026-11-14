import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { excuseController } from '../controllers/excuse.controller.js';
import { requireAuth, requireRole } from '../middlewares/auth.middleware.js';
import { Role } from '@prisma/client';

const router = Router();

// Ensure uploads/excuses directory exists
const uploadDir = path.resolve('uploads', 'excuses');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer disk storage for excuse proof files
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${Date.now()}-${crypto.randomUUID()}${ext}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (_req, file, cb) => {
    const allowedMimeTypes = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
      'image/heic',
    ];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file format. Only JPEG, PNG, WEBP, and PDF documents are accepted.'));
    }
  },
});

// Student routes
router.post(
  '/',
  requireAuth,
  requireRole(Role.STUDENT, Role.ADMIN),
  upload.single('document'),
  (req, res) => excuseController.submitExcuse(req, res)
);

router.get(
  '/my',
  requireAuth,
  requireRole(Role.STUDENT, Role.ADMIN),
  (req, res) => excuseController.getMyExcuses(req, res)
);

// Faculty & Admin routes
router.get(
  '/pending',
  requireAuth,
  requireRole(Role.FACULTY, Role.ADMIN),
  (req, res) => excuseController.getPendingExcuses(req, res)
);

router.patch(
  '/:id/review',
  requireAuth,
  requireRole(Role.FACULTY, Role.ADMIN),
  (req, res) => excuseController.reviewExcuse(req, res)
);

// Protected document download stream
router.get(
  '/:id/document',
  requireAuth,
  (req, res) => excuseController.downloadDocument(req, res)
);

export default router;
