import User from '../models/User.js';

export const getNearbyProfessionals = async (req, res) => {
  try {
    const { lng, lat, distance = 10, type = 'all' } = req.query; // type: 'vet', 'kennel', 'all'

    if (!lng || !lat) {
      return res.status(400).json({ message: "Coordinates are required." });
    }

    const radiusInMeters = distance * 1000;

    let query = {
      isVerified: true,
      location: {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: [parseFloat(lng), parseFloat(lat)],
          },
          $maxDistance: radiusInMeters,
        },
      },
    };

    if (type === 'vet') {
      query.role = 'vet';
    } else if (type === 'kennel') {
      query.role = 'kennel_owner';
    } else {
      query.role = { $in: ['vet', 'kennel_owner'] };
    }

    const professionals = await User.find(query)
      .select('name email role location vetDetails kennelDetails')
      .limit(20);

    res.status(200).json({
      success: true,
      count: professionals.length,
      data: professionals,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error during geolocation search." });
  }
};