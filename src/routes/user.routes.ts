import { Router } from 'express';
import { userController } from '../controllers/user.controller.js';
import { requireAuth, requireRole } from '../middlewares/auth.middleware.js';
import { Role } from '@prisma/client';

const router = Router();

// Retrieve all users (admin or faculty can view student rosters)
router.get('/', requireAuth, requireRole(Role.ADMIN, Role.FACULTY), (req, res) => userController.getAllUsers(req, res));

// Admin-only bulk operations — must be BEFORE /:id routes so '/bulk' isn't parsed as an id
router.post('/bulk', requireAuth, requireRole(Role.ADMIN), (req, res) => userController.massCreateUsers(req, res));
router.delete('/bulk', requireAuth, requireRole(Role.ADMIN), (req, res) => userController.massDeleteUsers(req, res));

// Single-user routes
router.get('/:id', requireAuth, (req, res) => userController.getUserById(req, res));
router.post('/', requireAuth, requireRole(Role.ADMIN), (req, res) => userController.createUser(req, res));
router.put('/:id', requireAuth, requireRole(Role.ADMIN), (req, res) => userController.updateUser(req, res));
router.delete('/:id', requireAuth, requireRole(Role.ADMIN), (req, res) => userController.deleteUser(req, res));

// RFID badge management
router.patch('/:id/rfid', requireAuth, requireRole(Role.ADMIN), (req, res) => userController.updateUserRfid(req, res));
router.delete('/:id/rfid', requireAuth, requireRole(Role.ADMIN), (req, res) => userController.removeUserRfid(req, res));

export default router;
