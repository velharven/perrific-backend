import { Router } from 'express';
import * as dashboardController from '../controllers/dashboardController';
import { authRequired } from '../middleware/auth';

const router = Router();

router.use(authRequired);

// Dashboard progres tim per project (F-07)
router.get('/projects/:projectId', dashboardController.projectProgress);
// Dashboard harian individu (F-07)
router.get('/me/daily', dashboardController.myDailyProgress);

export default router;
