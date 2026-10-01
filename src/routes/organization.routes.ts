import { Router } from 'express';
import * as orgController from '../controllers/organizationController';
import { authRequired } from '../middleware/auth';

const router = Router();

router.use(authRequired);

router.get('/', orgController.listMyOrganizations);
router.post('/', orgController.createOrganization);
router.get('/:id', orgController.getOrganization);
router.patch('/:id', orgController.updateOrganization);
router.delete('/:id', orgController.deleteOrganization);

router.post('/:id/teams', orgController.connectTeam);
router.delete('/:id/teams/:teamId', orgController.disconnectTeam);

router.post('/:id/members', orgController.addMember);
router.delete('/:id/members/:userId', orgController.removeMember);

router.post('/:id/propose-project', orgController.proposeProject);
router.post('/:id/send-task', orgController.sendTaskToProject);

export default router;
