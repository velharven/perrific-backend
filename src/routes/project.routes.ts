import { Router } from 'express';
import * as projectController from '../controllers/projectController';
import { authRequired } from '../middleware/auth';

const router = Router();

router.use(authRequired);

router.get('/:projectId', projectController.getProject);
router.patch('/:projectId', projectController.updateProject);
router.delete('/:projectId', projectController.deleteProject);
router.get('/:projectId/tasks', projectController.listTasks);
router.post('/:projectId/tasks', projectController.createTask);
router.patch('/:projectId/tasks/reorder', projectController.reorderTasks);
router.get('/:projectId/columns', projectController.listColumns);
router.post('/:projectId/columns', projectController.createColumn);
router.patch('/:projectId/columns/reorder', projectController.reorderColumns);
router.patch('/:projectId/columns/:columnId', projectController.updateColumn);
router.delete('/:projectId/columns/:columnId', projectController.deleteColumn);
router.get('/:projectId/roles', projectController.listRoles);
router.post('/:projectId/roles', projectController.createRole);
router.patch('/:projectId/roles/:roleId', projectController.updateRole);
router.delete('/:projectId/roles/:roleId', projectController.deleteRole);
router.get('/:projectId/members', projectController.listProjectMembers);
router.patch('/:projectId/members/:userId', projectController.setMemberRole);
router.get('/:projectId/comments', projectController.listAllComments);
router.get('/:projectId/activities', projectController.listAllActivities);
router.get('/:projectId/attachments', projectController.listAttachments);

export default router;
