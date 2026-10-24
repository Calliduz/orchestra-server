import { Router } from 'express';
import { authController } from '../controllers/auth.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

const router = Router();

router.post('/login', (req, res) => authController.login(req, res));
router.get('/me', requireAuth, (req, res) => authController.getProfile(req, res));

export default router;
