import { Router } from 'express';
import * as taskController from '../controllers/taskController';
import { authRequired } from '../middleware/auth';

const router = Router();

router.use(authRequired);

router.get('/assigned/me', taskController.listMyAssignedTasks);
router.get('/:taskId', taskController.getTask);
router.patch('/:taskId', taskController.updateTask);
router.post('/:taskId/comments', taskController.addComment);
router.get('/:taskId/comments', taskController.listComments);
router.patch('/:taskId/comments/:commentId', taskController.updateComment);
router.delete('/:taskId/comments/:commentId', taskController.deleteComment);
router.get('/:taskId/activities', taskController.listActivities);
router.post('/:taskId/attachments', taskController.addAttachment);
router.patch('/:taskId/attachments/:attachmentId', taskController.updateAttachment);
router.delete('/:taskId/attachments/:attachmentId', taskController.removeAttachment);
router.post('/:taskId/watchers', taskController.addWatcher);
router.delete('/:taskId/watchers/:userId', taskController.removeWatcher);
router.patch('/:taskId/approve', taskController.approveTask);
router.patch('/:taskId/reject', taskController.rejectTask);
router.delete('/:taskId', taskController.deleteTask);

export default router;
