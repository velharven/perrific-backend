import { Router } from 'express';
import authRoutes from './auth.routes';
import teamRoutes from './team.routes';
import projectRoutes from './project.routes';
import taskRoutes from './task.routes';
import activityRoutes from './activity.routes';
import notificationRoutes from './notification.routes';
import dashboardRoutes from './dashboard.routes';
import noteRoutes from './note.routes';
import tableRoutes from './table.routes';
import { health } from '../controllers';

const router = Router();

router.get('/health', health);
router.use('/auth', authRoutes);
router.use('/teams', teamRoutes);
router.use('/projects', projectRoutes);
router.use('/tasks', taskRoutes);
router.use('/activities', activityRoutes);
router.use('/notifications', notificationRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/notes', noteRoutes);
router.use('/tables', tableRoutes);

export default router;
