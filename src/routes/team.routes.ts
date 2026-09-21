import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as teamController from '../controllers/teamController';
import { authRequired } from '../middleware/auth';

const router = Router();

// Tebak kode dibatasi: 12 karakter acak + batas ini membuat brute force sia-sia.
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Terlalu banyak percobaan gabung, coba lagi nanti.' },
});

router.use(authRequired);

router.get('/', teamController.listMyTeams);
router.post('/', teamController.createTeam);
router.post('/join', joinLimiter, teamController.joinTeam);
router.get('/:teamId', teamController.getTeam);
router.patch('/:teamId', teamController.updateTeam);
router.delete('/:teamId', teamController.deleteTeam);
router.patch('/:teamId/invite', teamController.updateInvite);
router.get('/:teamId/pending-tasks', teamController.listPendingTasks);
router.get('/:teamId/join-requests', teamController.listJoinRequests);
router.post('/:teamId/join-requests/:requestId/approve', teamController.approveJoinRequest);
router.post('/:teamId/join-requests/:requestId/reject', teamController.rejectJoinRequest);
router.post('/:teamId/members', teamController.addMember);
router.delete('/:teamId/members/:userId', teamController.removeMember);
router.get('/:teamId/members', teamController.listMembers);
router.get('/:teamId/projects', teamController.listProjects);
router.post('/:teamId/projects', teamController.createProject);

export default router;
