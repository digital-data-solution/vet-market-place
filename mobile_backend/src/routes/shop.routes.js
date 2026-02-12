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

const router = express.Router();

// Public routes
router.get('/nearby', getNearbyShops); // Search nearby shops
router.get('/search', searchShops); // Search shops with text query
router.get('/list', listShops); // List all verified shops
router.get('/:id', getShopById); // Get specific shop by ID

// Protected routes (require authentication)
router.use(protect); // All routes below require authentication

router.post('/create', createShop); // Create shop
router.get('/me/shop', getMyShop); // Get own shop
router.put('/me/shop', updateShop); // Update own shop
router.delete('/me/shop', deleteShop); // Delete own shop

export default router;