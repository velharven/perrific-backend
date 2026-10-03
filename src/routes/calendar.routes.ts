import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as googleCalendarController from '../controllers/googleCalendarController';
import * as calendarLayoutController from '../controllers/calendarLayoutController';
import { authRequired } from '../middleware/auth';

const router = Router();

const calendarLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 menit
  max: 60, // maksimal 60 request per 5 menit
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId || req.ip || 'global',
  message: { success: false, message: 'Terlalu banyak permintaan kalender, silakan coba beberapa saat lagi.' },
});

router.use(authRequired);

router.get('/layout', calendarLayoutController.listLayout);
router.put('/layout/:date', calendarLayoutController.saveLayout);

// Google Calendar integration routes
router.get('/google/status', googleCalendarController.getStatus);
router.post('/google/connect', calendarLimiter, googleCalendarController.connect);
router.post('/google/disconnect', googleCalendarController.disconnect);
router.get('/google/events', googleCalendarController.listEvents);
router.post('/google/sync-activity/:activityId', googleCalendarController.syncActivity);
router.post('/google/import', googleCalendarController.importEvents);
router.post('/google/auto-sync', calendarLimiter, googleCalendarController.handleAutoSync);
router.post('/google/events', googleCalendarController.createEvent);
router.patch('/google/events/:eventId', googleCalendarController.updateEvent);
router.delete('/google/events/:eventId', googleCalendarController.deleteEvent);

export default router;
