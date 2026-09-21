import { Router } from 'express';
import * as activityController from '../controllers/activityController';
import { authRequired } from '../middleware/auth';

const router = Router();

router.use(authRequired);

// Notion-like: ?date=YYYY-MM-DD | ?from=&to=&status=&search=
router.get('/me', activityController.listMyActivities);
router.post('/', activityController.createActivity);
router.post('/reorder', activityController.reorderActivities);
router.patch('/:activityId', activityController.updateActivity);
router.delete('/:activityId', activityController.deleteActivity);
router.post('/:activityId/duplicate', activityController.duplicateActivity);

// Checklist blocks per activity (Notion sub-todos)
router.post('/:activityId/checklist', activityController.addChecklistItem);
router.patch('/checklist/:itemId', activityController.updateChecklistItem);
router.delete('/checklist/:itemId', activityController.deleteChecklistItem);

export default router;
