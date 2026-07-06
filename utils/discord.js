/**
 * Discord client integration.
 * Handles client lifecycle, message formatting (embeds vs plain text),
 * and robust message forwarding with retries.
 */

const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  AttachmentBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle 
} = require('discord.js');
const path = require('path');
const fs = require('fs');
const { config } = require('./config');
const logger = require('./logger');

let client = null;
let isReady = false;

/**
 * Initializes and connects the Discord client.
 * Retries indefinitely if initial connection fails.
 */
function connectDiscord() {
  return new Promise((resolve) => {
    if (client) {
      return resolve(client);
    }

    logger.info('Initializing Discord client...');

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
      ]
    });

    client.once('ready', () => {
      isReady = true;
      logger.success(`Discord connected: Logged in as ${client.user.tag}`);
      logger.info('Connected Discord');
      resolve(client);
    });

    client.on('error', (err) => {
      logger.error('Discord general client error:', err);
    });

    client.on('shardDisconnect', (event) => {
      isReady = false;
      logger.warning(`Discord disconnected (Code: ${event.code}). Reason: ${event.reason || 'Unknown'}. Reconnecting in ${config.reconnectDelay}ms...`);
    });

    client.on('shardReconnecting', () => {
      logger.info('Discord client attempting to reconnect to the gateway...');
    });

    const login = () => {
      client.login(config.discord.token).catch((err) => {
        logger.error(`Discord login failed: ${err.message}. Retrying in ${config.reconnectDelay}ms...`, null);
        setTimeout(login, config.reconnectDelay);
      });
    };

    login();
  });
}

/**
 * Helper to determine if a filename represents an image.
 */
function isImageFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
}

/**
 * Sends a message to the configured Discord channel with retry logic.
 * @param {Object} data - Message metadata
 * @param {string} data.text - Message content/caption
 * @param {string} data.senderName - Telegram sender display name
 * @param {string} [data.senderUsername] - Telegram sender username (optional)
 * @param {string} data.groupName - Telegram group/channel name
 * @param {Date} data.timestamp - Message timestamp
 * @param {string[]} data.mediaPaths - Array of absolute file paths to attach
 * @param {boolean} [data.hasMention] - True if Telegram message contains mentions
 * @param {string} [data.messageType] - Type of message (e.g. Text, Photo, Video)
 * @param {Array[]} [data.buttons] - 2D array of parsed link buttons [[{label, url}]]
 * @param {number} [retryCount=0] - Current retry count
 */
async function sendToDiscord(data, retryCount = 0) {
  const maxRetries = 5;
  if (!isReady || !client) {
    throw new Error('Discord client is not ready. Message deferred.');
  }

  // Resolve target channel
  const channel = await client.channels.fetch(config.discord.channelId);
  if (!channel) {
    throw new Error(`Discord channel with ID ${config.discord.channelId} not found.`);
  }

  // 1. Role Mention logic
  const mentionRoleId = config.discord.mentionRoleId;
  const mentionEveryMessage = config.discord.mentionEveryMessage;
  let shouldMention = false;

  if (mentionRoleId) {
    if (mentionEveryMessage) {
      shouldMention = true;
    } else {
      // If mention every message is false, check for mention keywords/elements in text
      const textLower = (data.text || '').toLowerCase();
      if (
        data.hasMention ||
        textLower.includes('@everyone') ||
        textLower.includes('@here') ||
        textLower.includes('alert') ||
        textLower.includes('ping')
      ) {
        shouldMention = true;
      }
    }
  }

  // 2. Build Buttons components
  let components = [];
  if (config.convertTelegramButtons && data.buttons && data.buttons.length > 0) {
    try {
      const limitedRows = data.buttons.slice(0, 5); // Discord allows max 5 action rows
      for (const rowButtons of limitedRows) {
        const rowBuilder = new ActionRowBuilder();
        const limitedButtons = rowButtons.slice(0, 5); // Discord allows max 5 buttons per row
        for (const btn of limitedButtons) {
          rowBuilder.addComponents(
            new ButtonBuilder()
              .setLabel(btn.label.substring(0, 80)) // Discord button label limit
              .setStyle(ButtonStyle.Link)
              .setURL(btn.url)
          );
        }
        if (rowBuilder.components.length > 0) {
          components.push(rowBuilder);
        }
      }
    } catch (btnErr) {
      logger.warning(`Discord button creation failed: ${btnErr.message}. Forwarding message without buttons.`);
      components = [];
    }
  }

  const payload = {};
  const files = [];

  // Prepare attachments
  if (data.mediaPaths && data.mediaPaths.length > 0) {
    for (const filePath of data.mediaPaths) {
      if (fs.existsSync(filePath)) {
        files.push(new AttachmentBuilder(filePath));
      } else {
        logger.warning(`File to attach was not found: ${filePath}`);
      }
    }
  }

  if (files.length > 0) {
    payload.files = files;
  }

  const timestamp = data.timestamp || new Date();

  // 3. Mention text in payload content (so it triggers notifications)
  if (mentionRoleId && shouldMention) {
    payload.content = `<@&${mentionRoleId}>`;
  }

  // 4. Build Embed / Plain Text
  if (config.discord.sendAsEmbed) {
    const embed = new EmbedBuilder()
      .setColor(config.discord.embedColor)
      .setDescription(data.text || null);

    // Author: Telegram group/channel name
    if (config.showChatName && data.groupName) {
      embed.setAuthor({ name: data.groupName });
    }

    // Title: Sender name
    if (data.senderName) {
      embed.setTitle(data.senderName);
    }

    // Fields: Message Type, Date
    const fields = [];
    if (data.messageType) {
      fields.push({ name: 'Message Type', value: data.messageType, inline: true });
    }
    if (config.showMessageDate && data.timestamp) {
      fields.push({ name: 'Date', value: data.timestamp.toLocaleString(), inline: true });
    }
    if (fields.length > 0) {
      embed.addFields(fields);
    }

    // Footer: Forwarded from Telegram or @username • Telegram
    let footerText = 'Forwarded from Telegram';
    if (config.showSenderUsername && data.senderUsername) {
      footerText = `@${data.senderUsername} • Telegram`;
    }
    embed.setFooter({ text: footerText });
    embed.setTimestamp(timestamp);

    payload.embeds = [embed];
  } else {
    // Plain text formatting fallback
    let formattedText = '';
    if (mentionRoleId && shouldMention) {
      formattedText += `<@&${mentionRoleId}>\n`;
    }
    formattedText += `**[${data.groupName || 'Telegram'}]**\n`;
    formattedText += `**${data.senderName || 'User'}**: `;
    formattedText += data.text || '';
    payload.content = formattedText.substring(0, 2000);
  }

  if (components.length > 0) {
    payload.components = components;
  }

  // 5. Temporarily make role mentionable if needed
  let roleEdited = false;
  let role = null;
  if (mentionRoleId && shouldMention) {
    try {
      role = await channel.guild.roles.fetch(mentionRoleId).catch(() => null);
      if (role && !role.mentionable) {
        logger.info(`Role ${role.name} (${mentionRoleId}) is not mentionable. Temporarily enabling mentionable status...`);
        await role.edit({ mentionable: true });
        roleEdited = true;
      }
    } catch (err) {
      logger.warning(`Failed to temporarily make role mentionable: ${err.message}`);
    }
  }

  try {
    logger.info(`Uploading message to Discord channel: ${config.discord.channelId}...`);
    const sentMsg = await channel.send(payload);

    // Logging: Forward success metadata
    const buttonCount = data.buttons ? data.buttons.reduce((sum, row) => sum + row.length, 0) : 0;
    logger.forward(data.senderName || 'Telegram User', {
      buttons: buttonCount,
      media: data.messageType || 'Text',
      discordMessageId: sentMsg.id
    });
    logger.success('Forward Complete');
  } catch (err) {
    // If sending with components failed, retry without components
    if (payload.components && payload.components.length > 0) {
      logger.warning(`Failed to send message with buttons: ${err.message}. Retrying without buttons...`);
      const noButtonsPayload = { ...payload };
      delete noButtonsPayload.components;
      try {
        const sentMsg = await channel.send(noButtonsPayload);
        logger.forward(data.senderName || 'Telegram User', {
          buttons: 0,
          media: data.messageType || 'Text',
          discordMessageId: sentMsg.id
        });
        logger.success('Forward Complete');
        return;
      } catch (noButtonsErr) {
        // Fallback to the new error and keep processing
        err = noButtonsErr;
      }
    }

    // If media/file upload failed, retry without attachments (still send embed)
    if (payload.files && payload.files.length > 0) {
      logger.warning(`Discord upload failed with media: ${err.message}. Retrying without media...`);
      const noMediaPayload = { ...payload };
      delete noMediaPayload.files;
      try {
        const sentMsg = await channel.send(noMediaPayload);
        const buttonCount = noMediaPayload.components ? data.buttons.reduce((sum, row) => sum + row.length, 0) : 0;
        logger.forward(data.senderName || 'Telegram User', {
          buttons: buttonCount,
          media: 'Text',
          discordMessageId: sentMsg.id
        });
        logger.success('Forward Complete');
        return;
      } catch (noMediaErr) {
        err = noMediaErr;
      }
    }

    // Handle Discord rate limit (429)
    if (err.status === 429 || (err.message && err.message.toLowerCase().includes('rate limit'))) {
      const retryAfter = err.retryAfter || 2000;
      logger.warning(`Discord rate limit hit. Retrying in ${retryAfter}ms...`);
      await new Promise((resolve) => setTimeout(resolve, retryAfter));
      const nextData = { ...data };
      // Strip failed media/buttons on retry to be safe
      if (payload.files) nextData.mediaPaths = [];
      if (payload.components) nextData.buttons = [];
      return sendToDiscord(nextData, retryCount);
    }

    // Standard Exponential Backoff retry
    if (retryCount < maxRetries) {
      const delay = Math.pow(2, retryCount) * 1000;
      logger.warning(`Discord send failure: ${err.message}. Retrying in ${delay}ms... (Attempt ${retryCount + 1}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      const nextData = { ...data };
      if (payload.files) nextData.mediaPaths = [];
      if (payload.components) nextData.buttons = [];
      return sendToDiscord(nextData, retryCount + 1);
    }

    throw err;
  } finally {
    // Restore role mentionability back to original (false)
    if (roleEdited && role) {
      try {
        logger.info(`Restoring role ${role.name} to non-mentionable status...`);
        await role.edit({ mentionable: false });
      } catch (restoreErr) {
        logger.warning(`Failed to restore role mentionable status: ${restoreErr.message}`);
      }
    }
  }
}

module.exports = {
  connectDiscord,
  sendToDiscord,
  isReady: () => isReady
};
