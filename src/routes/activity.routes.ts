import { Router } from 'express';
import * as activityController from '../controllers/activityController';
import { authRequired } from '../middleware/auth';

const router = Router();

router.use(authRequired);

// Notion-like: ?date=YYYY-MM-DD | ?from=&to=&status=&search=
router.get('/me', activityController.listMyActivities);
router.post('/', activityController.createActivity);
router.post('/reorder', activityController.reorderActivities);

// Properti kustom database harian (user-scoped, lintas tanggal)
router.get('/columns', activityController.listMyColumns);
router.post('/columns', activityController.createColumn);
router.post('/columns/reorder', activityController.reorderColumns);
router.patch('/columns/:columnId', activityController.updateColumn);
router.delete('/columns/:columnId', activityController.deleteColumn);
router.patch('/:activityId', activityController.updateActivity);
router.delete('/:activityId', activityController.deleteActivity);
router.post('/:activityId/duplicate', activityController.duplicateActivity);
router.patch('/:activityId/values', activityController.setCellValue);

// Checklist blocks per activity (Notion sub-todos)
router.post('/:activityId/checklist', activityController.addChecklistItem);
router.patch('/checklist/:itemId', activityController.updateChecklistItem);
router.delete('/checklist/:itemId', activityController.deleteChecklistItem);

export default router;
