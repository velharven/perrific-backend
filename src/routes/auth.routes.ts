import { Router } from 'express';
import * as authController from '../controllers/authController';
import { authRequired } from '../middleware/auth';

const router = Router();

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/google', authController.googleLogin);
router.get('/me', authRequired, authController.me);
router.patch('/me', authRequired, authController.updateMe);
router.post('/me/password', authRequired, authController.changePassword);
router.get('/check-username', authRequired, authController.checkUsername);

export default router;
