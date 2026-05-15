import express from 'express';
import {
  createShop,
  updateShop,
  getMyShop,
  getShopById,
  listShops,
  getNearbyShops,
  searchShops,
  deleteShop,
} from '../api/shop.controller.js';
import { protect } from '../middlewares/authMiddleware.js';
import { enforceSubscription } from '../middlewares/subscriptionMiddleware.js';

const router = express.Router();

// ─── Public named routes — must come before /:id wildcard ────────────────────
router.get('/nearby', protect, enforceSubscription, getNearbyShops);
router.get('/search', protect, enforceSubscription, searchShops);
router.get('/list',   protect, enforceSubscription, listShops);

// ─── Protected /me routes — must come before /:id wildcard ───────────────────
router.get('/me/shop',    protect, getMyShop);
router.put('/me/shop',    protect, updateShop);
router.delete('/me/shop', protect, deleteShop);
router.post('/create',    protect, createShop);

// ─── Wildcard — must be last ──────────────────────────────────────────────────
router.get('/:id', protect, enforceSubscription, getShopById);

export default router;