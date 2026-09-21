import { Router } from 'express';
import * as noteController from '../controllers/noteController';
import { authRequired } from '../middleware/auth';

const router = Router();

router.use(authRequired);

router.get('/me', noteController.listMyNotes);
router.post('/', noteController.createNote);
router.patch('/:noteId/move', noteController.moveNote);
router.get('/:noteId', noteController.getNote);
router.patch('/:noteId', noteController.updateNote);
router.delete('/:noteId', noteController.deleteNote);

export default router;
