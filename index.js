/**
 * Telegram to Discord Forwarder
 * Entry point. Initializes configuration, state, Discord & Telegram clients, and starts monitoring.
 */

const { validateConfig } = require('./utils/config');
const { loadState } = require('./utils/state');
const { connectDiscord } = require('./utils/discord');
const { connectTelegram, startMonitoring } = require('./utils/telegram');
const { handleNewMessage, handleEditedMessage } = require('./utils/forward');
const logger = require('./utils/logger');

// Global error handlers to ensure the application never crashes
process.on('uncaughtException', (err) => {
  logger.error('CRITICAL: Uncaught Exception detected in global process!', err);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('CRITICAL: Unhandled Promise Rejection detected in global process!', reason);
});

async function main() {
  logger.info('====================================================');
  logger.info('   Starting Telegram-Discord Forwarder Bot...       ');
  logger.info('====================================================');

  try {
    // 1. Validate Environment Variables
    validateConfig();
    logger.success('Environment configuration validated successfully.');

    // 2. Load Local State (previously forwarded message IDs)
    loadState();
    logger.success('Forwarder local state loaded successfully.');

    // 3. Connect to Discord
    logger.info('Connecting to Discord...');
    await connectDiscord();

    // 4. Connect to Telegram (Handles interactive CLI login if session is empty)
    logger.info('Connecting to Telegram...');
    await connectTelegram();

    // 5. Start listening to Telegram events and forwarding to Discord
    logger.info('Setting up Telegram event monitors...');
    await startMonitoring(handleNewMessage, handleEditedMessage);

    logger.success('Telegram-Discord Forwarder is fully operational and listening for messages!');
  } catch (err) {
    logger.error('Startup sequence encountered a critical error:', err);
    logger.info('Attempting startup recovery in 10 seconds...');
    setTimeout(main, 10000);
  }
}

main();
