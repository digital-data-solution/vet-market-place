import cloudinary from './cloudinary.js';

/**
 * Uploads a file buffer to Cloudinary and returns the URL.
 * @param {Buffer|string} file - File buffer or base64 string
 * @param {string} folder - Cloudinary folder (e.g. 'profiles')
 * @returns {Promise<string>} - The Cloudinary URL
 */
export async function uploadToCloudinary(file, folder = 'profiles') {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
        transformation: [
          { width: 800, height: 800, crop: 'limit', quality: 'auto' },
        ],
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    ).end(file);
  });
}
