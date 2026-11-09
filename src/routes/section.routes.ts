import { Router } from 'express';
import { sectionController } from '../controllers/section.controller.js';
import { requireAuth, requireRole } from '../middlewares/auth.middleware.js';
import { Role } from '@prisma/client';

const router = Router();

// Public / Authenticated read
router.get('/', (req, res) => sectionController.getAllSections(req, res));
router.get('/my', requireAuth, (req, res) => sectionController.getMySections(req, res));
router.get('/:id', (req, res) => sectionController.getSectionById(req, res));

// Admin CRUD
router.post('/', requireAuth, requireRole(Role.ADMIN), (req, res) => sectionController.createSection(req, res));
router.put('/:id', requireAuth, requireRole(Role.ADMIN), (req, res) => sectionController.updateSection(req, res));
router.delete('/:id', requireAuth, requireRole(Role.ADMIN), (req, res) => sectionController.deleteSection(req, res));

export default router;

