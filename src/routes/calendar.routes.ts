import { Router } from 'express';
import * as googleCalendarController from '../controllers/googleCalendarController';
import { authRequired } from '../middleware/auth';

const router = Router();

router.use(authRequired);

// Google Calendar integration routes
router.get('/google/status', googleCalendarController.getStatus);
router.post('/google/connect', googleCalendarController.connect);
router.post('/google/disconnect', googleCalendarController.disconnect);
router.get('/google/events', googleCalendarController.listEvents);
router.post('/google/sync-activity/:activityId', googleCalendarController.syncActivity);
router.post('/google/import', googleCalendarController.importEvents);
router.post('/google/auto-sync', googleCalendarController.handleAutoSync);

export default router;
