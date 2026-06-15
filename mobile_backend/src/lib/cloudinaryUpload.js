import cloudinary from './cloudinary.js';

/**
 * Derives a stable Cloudinary public_id from a secure_url so we can delete later.
 * Example URL:
 *   https://res.cloudinary.com/<cloud>/image/upload/v1234567890/profiles/user-123-456.jpg
 * Extracted public_id: profiles/user-123-456
 */
export function publicIdFromUrl(url) {
  try {
    // Strip query-string / version prefix, keep folder/filename without extension
    const parts = url.split('/upload/');
    if (parts.length < 2) return null;
    const withVersion = parts[1]; // e.g. "v1234567890/profiles/user-123.jpg"
    const withoutVersion = withVersion.replace(/^v\d+\//, ''); // "profiles/user-123.jpg"
    const withoutExt = withoutVersion.replace(/\.[^.]+$/, '');  // "profiles/user-123"
    return withoutExt;
  } catch {
    return null;
  }
}

/**
 * Uploads a file buffer to Cloudinary.
 *
 * @param {Buffer} fileBuffer   - Raw file bytes
 * @param {object} options
 * @param {string} options.folder      - Cloudinary folder ('profiles' | 'vet' | 'kennel' | 'shop')
 * @param {string} [options.publicId]  - Optional deterministic public_id (without folder prefix)
 * @returns {Promise<{ url: string, publicId: string }>}
 */
export async function uploadToCloudinary(fileBuffer, { folder = 'profiles', publicId } = {}) {
  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder,
      resource_type: 'image',
      transformation: [
        { width: 1200, height: 1200, crop: 'limit', fetch_format: 'auto', quality: 'auto:good' },
      ],
    };

    // Use a deterministic public_id when provided (e.g. userId-based)
    // so re-uploading the same user's profile photo replaces the old one.
    if (publicId) {
      uploadOptions.public_id = publicId;
      uploadOptions.overwrite = true;
      uploadOptions.invalidate = true; // Bust Cloudinary CDN cache
    }

    const stream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) return reject(error);
        resolve({
          url: result.secure_url,
          publicId: result.public_id, // e.g. "profiles/user-abc-123"
        });
      }
    );

    stream.end(fileBuffer);
  });
}

/**
 * Deletes an image from Cloudinary by its full URL or explicit public_id.
 *
 * @param {string} urlOrPublicId - Cloudinary secure_url OR public_id string
 * @returns {Promise<boolean>} - true if deleted, false if not found / error
 */
export async function deleteFromCloudinary(urlOrPublicId) {
  try {
    // Detect whether we were given a URL or already a public_id
    const publicId = urlOrPublicId.startsWith('http')
      ? publicIdFromUrl(urlOrPublicId)
      : urlOrPublicId;

    if (!publicId) {
      console.warn('⚠️  deleteFromCloudinary: could not derive public_id from', urlOrPublicId);
      return false;
    }

    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: 'image',
      invalidate: true,
    });

    // result.result === 'ok' means deleted; 'not found' means already gone
    return result.result === 'ok';
  } catch (error) {
    console.error('❌ Cloudinary delete error:', error);
    return false;
  }
}