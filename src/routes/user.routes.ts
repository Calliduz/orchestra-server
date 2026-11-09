import { Router } from 'express';
import { userController } from '../controllers/user.controller.js';
import { requireAuth, requireRole } from '../middlewares/auth.middleware.js';
import { Role } from '@prisma/client';

const router = Router();

// Retrieve all users (admin or faculty can view student rosters)
router.get('/', (req, res) => userController.getAllUsers(req, res));
router.get('/:id', (req, res) => userController.getUserById(req, res));

// Admin-only management endpoints
router.post('/', requireAuth, requireRole(Role.ADMIN), (req, res) => userController.createUser(req, res));
router.put('/:id', requireAuth, requireRole(Role.ADMIN), (req, res) => userController.updateUser(req, res));
router.delete('/:id', requireAuth, requireRole(Role.ADMIN), (req, res) => userController.deleteUser(req, res));

// RFID badge management
router.patch('/:id/rfid', requireAuth, requireRole(Role.ADMIN), (req, res) => userController.updateUserRfid(req, res));
router.delete('/:id/rfid', requireAuth, requireRole(Role.ADMIN), (req, res) => userController.removeUserRfid(req, res));

export default router;
