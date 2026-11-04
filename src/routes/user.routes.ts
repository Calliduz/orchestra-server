import { Router } from 'express';
import { userController } from '../controllers/user.controller.js';

const router = Router();

router.get('/', (req, res) => userController.getAllUsers(req, res));
router.patch('/:id/rfid', (req, res) => userController.updateUserRfid(req, res));
router.delete('/:id/rfid', (req, res) => userController.removeUserRfid(req, res));

export default router;

