/**
 * Configuration manager. Loads environment variables, validates them, and exposes them.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from .env file in project root
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  // Try loading default .env from current directory in case of execution from parent directories
  dotenv.config();
}

// Helper to parse boolean from environment string
function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return value.toLowerCase() === 'true';
}

// Helper to parse integer
function parseIntValue(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

const config = {
  // Telegram settings
  telegram: {
    apiId: parseIntValue(process.env.API_ID, null),
    apiHash: process.env.API_HASH || null,
    stringSession: process.env.STRING_SESSION || '',
    chat: process.env.TELEGRAM_CHAT || null
  },

  // Discord settings
  discord: {
    token: process.env.DISCORD_TOKEN || null,
    channelId: process.env.DISCORD_CHANNEL_ID || null,
    embedColor: process.env.EMBED_COLOR || '#5865F2',
    sendAsEmbed: parseBool(process.env.SEND_AS_EMBED, true),
    mentionRoleId: process.env.MENTION_ROLE_ID || '',
    mentionEveryMessage: parseBool(process.env.MENTION_EVERY_MESSAGE, true)
  },

  // Display details configuration
  showSenderUsername: parseBool(process.env.SHOW_SENDER_USERNAME, true),
  showChatName: parseBool(process.env.SHOW_CHAT_NAME, true),
  showMessageDate: parseBool(process.env.SHOW_MESSAGE_DATE, true),
  convertTelegramButtons: parseBool(process.env.CONVERT_TELEGRAM_BUTTONS, true),

  // Forward settings
  forwardEdits: parseBool(process.env.FORWARD_EDITS, false),

  // Media download settings
  downloadMedia: parseBool(process.env.DOWNLOAD_MEDIA, true),
  deleteTempFiles: parseBool(process.env.DELETE_TEMP_FILES, true),
  maxFileSizeMb: parseIntValue(process.env.MAX_FILE_SIZE_MB, 24),

  // General settings
  reconnectDelay: parseIntValue(process.env.RECONNECT_DELAY, 5000)
};

// Validate critical parameters
function validateConfig() {
  const missing = [];

  if (!config.telegram.apiId) missing.push('API_ID');
  if (!config.telegram.apiHash) missing.push('API_HASH');
  if (!config.telegram.chat) missing.push('TELEGRAM_CHAT');
  if (!config.discord.token) missing.push('DISCORD_TOKEN');
  if (!config.discord.channelId) missing.push('DISCORD_CHANNEL_ID');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}. Please refer to .env.example.`);
  }
}

module.exports = {
  config,
  validateConfig
};
