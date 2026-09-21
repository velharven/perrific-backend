import { Router } from 'express';
import * as notificationController from '../controllers/notificationController';
import { authRequired } from '../middleware/auth';

const router = Router();

router.use(authRequired);

router.get('/', notificationController.listNotifications);
router.patch('/:notificationId/read', notificationController.markRead);

export default router;
