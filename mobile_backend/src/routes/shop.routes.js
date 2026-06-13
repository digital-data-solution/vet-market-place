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
import { protect }                                 from '../middlewares/authMiddleware.js';
import { enforceSubscription, attachSubscription } from '../middlewares/subscriptionMiddleware.js';
import { requireShopOwner } from '../middlewares/ownershipMiddleware.js';

const router = express.Router();

// ─── Public named routes ──────────────────────────────────────────────────────
router.get('/nearby', protect, enforceSubscription, getNearbyShops);
router.get('/search', protect, enforceSubscription, searchShops);
router.get('/list',   protect, attachSubscription,  listShops);

// ─── Protected /me routes ─────────────────────────────────────────────────────
router.get('/me/shop',    protect, getMyShop);
router.post('/create',    protect, createShop);                         // anyone can create (creates ownership)
router.put('/me/shop',    protect, requireShopOwner, updateShop);       // must own shop
router.delete('/me/shop', protect, requireShopOwner, deleteShop);       // must own shop

// ─── Wildcard last ────────────────────────────────────────────────────────────
router.get('/:id', protect, attachSubscription, getShopById);

export default router;