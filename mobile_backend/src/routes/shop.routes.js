import express from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import { createShop, getNearbyShops, getShopById, searchShops } from '../api/shop.controller.js';

const router = express.Router();

// POST /api/v1/shops/create
router.post('/create', protect, createShop);

// GET /api/v1/shops/search?q=&lng=&lat=&distance=
router.get('/search', searchShops);

// GET /api/v1/shops/nearby?lng=&lat=&distance=
router.get('/nearby', getNearbyShops);

// GET /api/v1/shops/:id
router.get('/:id', getShopById);

// GET /api/v1/shops - list all shops
router.get('/', listShops);

export default router;
