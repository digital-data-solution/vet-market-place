import cloudinary from '../lib/cloudinary.js';

/**
 * Uploads a file buffer to Cloudinary and returns the URL.
 * @param {Buffer|string} file - File buffer or base64 string
 * @param {string} folder - Cloudinary folder (e.g. 'profiles', 'vet', 'kennel', 'shop')
 * @param {object} options - Additional upload options
 * @returns {Promise<string>} - The Cloudinary secure URL
 */
export async function uploadToCloudinary(file, folder = 'profiles', options = {}) {
  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder,
      resource_type: 'image',
      transformation: [
        { 
          width: 1200, 
          height: 1200, 
          crop: 'limit', 
          quality: 'auto:good',
          fetch_format: 'auto', // Automatic format selection (WebP, etc.)
        },
      ],
      ...options,
    };

    const uploadStream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          console.error('Cloudinary upload error:', error);
          return reject(error);
        }
        resolve(result.secure_url);
      }
    );

    // Handle buffer or stream
    if (Buffer.isBuffer(file)) {
      uploadStream.end(file);
    } else if (typeof file === 'string') {
      // Base64 string
      cloudinary.uploader.upload(file, uploadOptions, (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      });
    } else {
      reject(new Error('Invalid file type. Expected Buffer or base64 string.'));
    }
  });
}

/**
 * Deletes an image from Cloudinary by public_id
 * @param {string} publicId - The Cloudinary public_id (includes folder path)
 * @returns {Promise<object>} - Cloudinary deletion result
 */
export async function deleteFromCloudinary(publicId) {
  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: 'image',
    });

    if (result.result !== 'ok' && result.result !== 'not found') {
      throw new Error(`Failed to delete image: ${result.result}`);
    }

    return result;
  } catch (error) {
    console.error('Cloudinary delete error:', error);
    throw error;
  }
}

/**
 * Delete multiple images from Cloudinary
 * @param {string[]} publicIds - Array of Cloudinary public_ids
 * @returns {Promise<object>} - Deletion results
 */
export async function deleteMultipleFromCloudinary(publicIds) {
  try {
    const result = await cloudinary.api.delete_resources(publicIds, {
      resource_type: 'image',
    });

    return result;
  } catch (error) {
    console.error('Cloudinary bulk delete error:', error);
    throw error;
  }
}

/**
 * Extract public_id from Cloudinary URL
 * @param {string} url - Cloudinary URL
 * @returns {string} - Public ID
 */
export function extractPublicId(url) {
  const urlParts = url.split('/');
  const uploadIndex = urlParts.findIndex((part) => part === 'upload');

  if (uploadIndex === -1) {
    throw new Error('Invalid Cloudinary URL');
  }

  // Get public_id (includes folder path)
  const publicIdWithExt = urlParts.slice(uploadIndex + 2).join('/');
  return publicIdWithExt.replace(/\.[^/.]+$/, ''); // Remove extension
}

export default {
  uploadToCloudinary,
  deleteFromCloudinary,
  deleteMultipleFromCloudinary,
  extractPublicId,
};