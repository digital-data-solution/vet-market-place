import Shop         from '../models/Shop.js';
import Professional from '../models/Professional.js';

// ─── Shop ownership ───────────────────────────────────────────────────────────
export const requireShopOwner = async (req, res, next) => {
  try {
    const shop = await Shop.findOne({ owner: req.user._id }).lean();
    if (!shop) {
      return res.status(403).json({
        success: false,
        message: 'You do not own a shop.',
        action:  'create_shop',
      });
    }
    req.shop = shop;
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─── Professional ownership (vet or kennel) ───────────────────────────────────
export const requireProfessionalOwner = async (req, res, next) => {
  try {
    const profile = await Professional.findOne({ userId: req.user._id }).lean();
    if (!profile) {
      return res.status(403).json({
        success: false,
        message: 'You do not have a professional profile.',
        action:  'create_profile',
      });
    }
    req.professional = profile;
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─── Kennel ownership (Professional doc with role === 'kennel') ───────────────
export const requireKennelOwner = async (req, res, next) => {
  try {
    const profile = await Professional.findOne({
      userId: req.user._id,
      role:   'kennel',
    }).lean();

    if (!profile) {
      return res.status(403).json({
        success: false,
        message: 'You do not own a kennel.',
        action:  'create_kennel',
      });
    }
    req.kennel = profile;
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─── Vet ownership ────────────────────────────────────────────────────────────
export const requireVetOwner = async (req, res, next) => {
  try {
    const profile = await Professional.findOne({
      userId: req.user._id,
      role:   'vet',
    }).lean();

    if (!profile) {
      return res.status(403).json({
        success: false,
        message: 'You do not have a vet profile.',
        action:  'create_profile',
      });
    }
    req.vet = profile;
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};