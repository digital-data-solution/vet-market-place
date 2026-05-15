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

// Named routes — before /:id wildcard
router.get('/nearby', enforceSubscription, getNearbyShops);
router.get('/search', enforceSubscription, searchShops);
router.get('/list',   enforceSubscription, listShops);

// Protected /me routes — before /:id wildcard
router.get('/me/shop',    protect, getMyShop);
router.put('/me/shop',    protect, updateShop);
router.delete('/me/shop', protect, deleteShop);
router.post('/create',    protect, createShop);

// Wildcard — last
router.get('/:id', enforceSubscription, getShopById);

export default router;
