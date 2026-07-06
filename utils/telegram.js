/**
 * Telegram client integration using GramJS.
 * Handles authentication (both session-based and interactive prompt),
 * chat resolution (ID, Username, Title), message events, and reconnection.
 */

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage, EditedMessage } = require('telegram/events');
const readline = require('readline/promises');
const { config } = require('./config');
const logger = require('./logger');

let client = null;
let targetEntity = null;
let targetChatName = '';
let connectionActive = false;

/**
 * Searches the user's dialogs to resolve a chat by title, username, or ID.
 */
async function resolveTargetChat(clientInstance, chatIdentifier) {
  const cleanIdentifier = chatIdentifier.trim();

  // 1. Try resolving direct integer/bigint chat IDs
  if (/^-?\d+$/.test(cleanIdentifier)) {
    try {
      const chatIdBigInt = BigInt(cleanIdentifier);
      return await clientInstance.getEntity(chatIdBigInt);
    } catch (e) {
      // Keep going to dialog search
    }
  }

  // 2. Try username directly if it starts with @
  if (cleanIdentifier.startsWith('@')) {
    try {
      return await clientInstance.getEntity(cleanIdentifier);
    } catch (e) {
      // Keep going
    }
  }

  // 3. Scan user dialogs (covers Group Titles, Username without @, and IDs)
  try {
    logger.info('Fetching account dialogs (chats) to find target match...');
    const dialogs = await clientInstance.getDialogs({});
    for (const dialog of dialogs) {
      const entity = dialog.entity;
      const title = dialog.title;
      const username = entity.username;
      const idStr = entity.id ? entity.id.toString() : '';

      // Compare lowercase titles, usernames, and IDs
      if (
        (title && title.toLowerCase() === cleanIdentifier.toLowerCase()) ||
        (username && username.toLowerCase() === cleanIdentifier.toLowerCase()) ||
        (username && username.toLowerCase() === cleanIdentifier.replace('@', '').toLowerCase()) ||
        idStr === cleanIdentifier
      ) {
        return entity;
      }
    }
  } catch (err) {
    logger.warning(`Failed to scan dialogs for chat match: ${err.message}. Trying direct lookup...`);
  }

  // 4. Try direct getEntity call as fallback
  try {
    return await clientInstance.getEntity(cleanIdentifier);
  } catch (e) {
    throw new Error(
      `Could not resolve Telegram chat: "${chatIdentifier}".\n` +
      `Please ensure: \n` +
      `1. The name/ID is correct.\n` +
      `2. Your Telegram account has joined/is a member of the group/channel.\n` +
      `3. For titles, make sure it matches the exact spelling.`
    );
  }
}

/**
 * Prompts user for credentials and establishes Telegram client connection.
 * Supports interactive OTP/2FA generation on first login.
 */
async function connectTelegram() {
  if (client && connectionActive) {
    return client;
  }

  logger.info('Initializing Telegram client (GramJS)...');
  const session = new StringSession(config.telegram.stringSession);

  client = new TelegramClient(session, config.telegram.apiId, config.telegram.apiHash, {
    connectionRetries: 99999, // Retry indefinitely
    useWSS: false
  });

  const runInteractiveLogin = async () => {
    logger.info('STRING_SESSION is missing or invalid. Initiating interactive Telegram login...');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    try {
      await client.start({
        phoneNumber: async () => {
          const phone = await rl.question('Please enter your Telegram phone number (with country code, e.g. +123456789): ');
          return phone.trim();
        },
        password: async () => {
          const pwd = await rl.question('Please enter your 2FA password (press Enter if you don\'t have one): ');
          return pwd.trim();
        },
        phoneCode: async () => {
          const code = await rl.question('Please enter the OTP/code you received from Telegram: ');
          return code.trim();
        },
        onError: (err) => {
          logger.error('Error during Telegram interactive login step:', err);
        }
      });

      const sessionStr = client.session.save();
      logger.success('Telegram logged in successfully!');
      console.log('\n========================================================================');
      console.log('STRING_SESSION GENERATED SUCCESSFULLY:');
      console.log('Copy and paste the string below into your .env file:');
      console.log('========================================================================\n');
      console.log(sessionStr);
      console.log('\n========================================================================\n');

      config.telegram.stringSession = sessionStr;
    } catch (err) {
      logger.error('Telegram authentication failed:', err);
      throw err;
    } finally {
      rl.close();
    }
  };

  try {
    if (!config.telegram.stringSession) {
      await runInteractiveLogin();
    } else {
      logger.info('Connecting to Telegram servers...');
      await client.connect();
      const authorized = await client.isUserAuthorized();
      if (!authorized) {
        logger.warning('Session exists but is unauthorized/expired.');
        await runInteractiveLogin();
      } else {
        logger.success('Telegram connected successfully using existing session.');
      }
    }

    connectionActive = true;
    logger.info('Connected Telegram');
    return client;
  } catch (err) {
    logger.error('Failed to establish Telegram connection. Retrying in ' + config.reconnectDelay + 'ms...', err);
    connectionActive = false;
    await new Promise((resolve) => setTimeout(resolve, config.reconnectDelay));
    return connectTelegram();
  }
}

/**
 * Sets up listeners for Telegram messages.
 * @param {Function} onNewMessage - Callback when a new message is received
 * @param {Function} onEditMessage - Callback when an edited message is received
 */
async function startMonitoring(onNewMessage, onEditMessage) {
  try {
    targetEntity = await resolveTargetChat(client, config.telegram.chat);
    
    // Determine a clean display name
    targetChatName = targetEntity.title || targetEntity.username || 'Private Chat';
    if (targetEntity.firstName || targetEntity.lastName) {
      targetChatName = [targetEntity.firstName, targetEntity.lastName].filter(Boolean).join(' ');
    }

    const targetIdStr = targetEntity.id.toString();
    logger.success(`Watching Telegram chat: "${targetChatName}" (ID: ${targetIdStr})`);

    // Handle new message event
    client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message) return;

        const peerId = await client.getPeerId(message.peerId).catch(() => null);
        if (!peerId) return;

        if (peerId.toString() !== targetIdStr) {
          return; // Ignore other chats
        }

        await onNewMessage(client, message, targetChatName);
      } catch (err) {
        logger.error('Error handling Telegram NewMessage event:', err);
      }
    }, new NewMessage({}));

    // Handle edited message event
    if (config.forwardEdits) {
      client.addEventHandler(async (event) => {
        try {
          const message = event.message;
          if (!message) return;

          const peerId = await client.getPeerId(message.peerId).catch(() => null);
          if (!peerId) return;

          if (peerId.toString() !== targetIdStr) {
            return; // Ignore other chats
          }

          await onEditMessage(client, message, targetChatName);
        } catch (err) {
          logger.error('Error handling Telegram EditedMessage event:', err);
        }
      }, new EditedMessage({}));
    }

    // Monitor client disconnect event to log and handle reconnects
    client.on('disconnect', () => {
      logger.warning('Telegram client disconnected. GramJS auto-reconnection in progress...');
      connectionActive = false;
    });

  } catch (err) {
    logger.error('Failed to start monitoring Telegram chat. Retrying in ' + config.reconnectDelay + 'ms...', err);
    await new Promise((resolve) => setTimeout(resolve, config.reconnectDelay));
    return startMonitoring(onNewMessage, onEditMessage);
  }
}

module.exports = {
  connectTelegram,
  startMonitoring,
  getClient: () => client,
  getTargetEntity: () => targetEntity,
  getTargetChatName: () => targetChatName
};
