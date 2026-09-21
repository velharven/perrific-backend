import { Router } from 'express';
import { authRequired } from '../middleware/auth';
import * as tableController from '../controllers/tableController';

const router = Router();
router.use(authRequired);
router.get('/:noteId', tableController.getTable);
router.put('/:noteId', tableController.updateTable);
export default router;
