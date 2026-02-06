import express from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import { createShop, getNearbyShops, getShopById } from '../api/shop.controller.js';

const router = express.Router();

// POST /api/v1/shops/create
router.post('/create', protect, createShop);

// GET /api/v1/shops/nearby?lng=&lat=&distance=
router.get('/nearby', getNearbyShops);

// GET /api/v1/shops/:id
router.get('/:id', getShopById);

export default router;
