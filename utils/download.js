/**
 * Media download utility for Telegram.
 * Handles file size checking, downloading, naming, and cleanup.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { config } = require('./config');

const DOWNLOADS_DIR = path.resolve(__dirname, '../downloads');

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

/**
 * Maps a mime-type to a file extension.
 */
function getExtensionFromMime(mimeType) {
  if (!mimeType) return '.bin';
  const mime = mimeType.toLowerCase();
  if (mime.includes('image/png')) return '.png';
  if (mime.includes('image/jpeg') || mime.includes('image/jpg')) return '.jpg';
  if (mime.includes('image/gif')) return '.gif';
  if (mime.includes('image/webp')) return '.webp';
  if (mime.includes('video/mp4')) return '.mp4';
  if (mime.includes('video/webm')) return '.webm';
  if (mime.includes('audio/mpeg') || mime.includes('audio/mp3')) return '.mp3';
  if (mime.includes('audio/ogg') || mime.includes('application/ogg')) return '.ogg';
  if (mime.includes('application/pdf')) return '.pdf';
  if (mime.includes('text/plain')) return '.txt';
  return '.bin';
}

/**
 * Inspects a Telegram media object and returns metadata (filename, size in bytes).
 */
function getMediaMetadata(media, msgId) {
  if (!media) return null;

  let fileName = `media_${msgId}_${Date.now()}`;
  let size = 0;

  // Handle document types (videos, audios, files, gifs)
  if (media.document) {
    const doc = media.document;
    size = Number(doc.size || 0);

    // Look for filename in attributes
    if (doc.attributes) {
      for (const attr of doc.attributes) {
        if (attr.className === 'DocumentAttributeFilename' && attr.fileName) {
          return { fileName: attr.fileName, size };
        }
      }
    }

    // Guess from mime-type
    const ext = getExtensionFromMime(doc.mimeType);
    fileName += ext;
    return { fileName, size };
  }

  // Handle photo types
  if (media.photo) {
    // Photos don't have explicit size in root, size is nested in sizes array.
    // The last element is usually the largest size.
    const sizes = media.photo.sizes || [];
    const largestSize = sizes[sizes.length - 1];
    size = largestSize ? Number(largestSize.size || 0) : 0;
    fileName += '.jpg';
    return { fileName, size };
  }

  // Handle web page previews / other types with possible media
  if (media.webpage && media.webpage.photo) {
    return getMediaMetadata({ photo: media.webpage.photo }, msgId);
  }

  // General fallback
  fileName += '.bin';
  return { fileName, size };
}

/**
 * Downloads a media attachment from a Telegram message.
 * @param {TelegramClient} client - The active GramJS client
 * @param {Message} message - The message object
 * @returns {Promise<string|null>} Absolute file path of downloaded media, or null if skipped/failed
 */
async function downloadMedia(client, message) {
  const media = message.media;
  if (!media) return null;

  const msgId = message.id;

  try {
    const meta = getMediaMetadata(media, msgId);
    if (!meta) return null;

    const limitBytes = config.maxFileSizeMb * 1024 * 1024;
    if (meta.size > limitBytes) {
      const sizeMb = meta.size / (1024 * 1024);
      logger.warning(
        `Media skipped: File size of ${sizeMb.toFixed(2)}MB exceeds MAX_FILE_SIZE_MB (${config.maxFileSizeMb}MB). Message ID: ${msgId}`
      );
      return null;
    }

    const filePath = path.join(DOWNLOADS_DIR, meta.fileName);
    logger.info(`Downloading media for Message ID ${msgId}: ${meta.fileName} (${(meta.size / 1024 / 1024).toFixed(2)}MB)...`);

    const buffer = await client.downloadMedia(message, {});

    if (buffer) {
      fs.writeFileSync(filePath, buffer);
      logger.success(`Downloaded media: ${meta.fileName} to ${filePath}`);
      return filePath;
    }

    logger.warning(`Failed to download media for Message ID ${msgId}: Buffer was empty.`);
    return null;
  } catch (err) {
    logger.error(`Error downloading media for Message ID ${msgId}:`, err);
    return null;
  }
}

/**
 * Deletes a file from disk if deleteTempFiles config is true.
 * @param {string} filePath - Absolute file path
 */
function cleanTempFile(filePath) {
  if (!config.deleteTempFiles) return;

  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.info(`Deleted temporary file: ${path.basename(filePath)}`);
    }
  } catch (err) {
    logger.error(`Failed to delete temporary file ${filePath}:`, err);
  }
}

module.exports = {
  downloadMedia,
  cleanTempFile
};
