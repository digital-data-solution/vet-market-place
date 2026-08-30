import express from 'express';
import { adminProtect, requireOwner } from '../middlewares/adminAuthMiddleware.js';
import {
  listModules, listStaff, createStaff, updateStaff, resetStaffPassword, resetStaffTwoFactor, deleteStaff,
} from '../api/admin.staff.controller.js';

const router = express.Router();
router.use(adminProtect);

// Any authenticated admin (owner or staff) can read the module label list —
// a staff dashboard needs it too, to render its own nav from its granted keys.
router.get('/modules', listModules);

// Everything else — creating/editing/removing staff accounts — is owner only.
router.get('/',                    requireOwner, listStaff);
router.post('/',                   requireOwner, createStaff);
router.put('/:id',                 requireOwner, updateStaff);
router.post('/:id/reset-password', requireOwner, resetStaffPassword);
router.post('/:id/reset-2fa',      requireOwner, resetStaffTwoFactor);
router.delete('/:id',              requireOwner, deleteStaff);

export default router;
