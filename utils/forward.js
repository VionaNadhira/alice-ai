/**
 * Forwarding coordinator.
 * Implements filters, duplicate detection, and Telegram album grouping (multi-attachment debouncing).
 */

const { downloadMedia, cleanTempFile } = require('./download');
const { sendToDiscord } = require('./discord');
const { isAlreadyForwarded, markAsForwarded } = require('./state');
const { config } = require('./config');
const logger = require('./logger');

// Debounce map for Telegram albums (grouped messages)
// Key: groupedId (string), Value: { timer, messages: Array, chatName: string }
const groupedCache = new Map();
const ALBUM_DEBOUNCE_MS = 1500; // Wait 1.5 seconds to gather all parts of the album

/**
 * Validates whether a Telegram message should be ignored based on business filters.
 */
function shouldIgnoreMessage(message) {
  // 1. Ignore Service/Action Messages (Joins, leaves, pins, chat name edits, photo changes)
  if (message.action) {
    const className = message.action.className;
    logger.info(`Message filtered out: Service/Action message (${className}). Message ID: ${message.id}`);
    return true;
  }

  // 2. Ignore empty messages (no caption/text AND no media attachments)
  const hasText = !!(message.message && message.message.trim());
  const hasMedia = !!message.media;
  if (!hasText && !hasMedia) {
    logger.info(`Message filtered out: Empty message (no text and no media). Message ID: ${message.id}`);
    return true;
  }

  return false;
}

/**
 * Helper to determine the message/media type of a Telegram message.
 * Supports: Text, Photo, Video, GIF, Sticker, Document, Voice, Animation.
 */
function getMessageType(message) {
  if (!message.media) return 'Text';

  const media = message.media;
  if (media.photo) return 'Photo';
  
  if (media.document) {
    const doc = media.document;
    const mime = (doc.mimeType || '').toLowerCase();

    let isVideo = false;
    let isGif = false;
    let isVoice = false;
    let isSticker = false;

    if (doc.attributes) {
      for (const attr of doc.attributes) {
        if (attr.className === 'DocumentAttributeVideo') {
          isVideo = true;
        }
        if (attr.className === 'DocumentAttributeAnimated') {
          isGif = true;
        }
        if (attr.className === 'DocumentAttributeAudio' && attr.voice) {
          isVoice = true;
        }
        if (attr.className === 'DocumentAttributeSticker') {
          isSticker = true;
        }
      }
    }

    if (mime.includes('image/gif')) return 'GIF';
    if (isGif) return 'Animation';
    if (isSticker || mime.includes('image/webp')) return 'Sticker';
    if (isVoice || mime.includes('audio/ogg')) return 'Voice';
    if (isVideo || mime.includes('video/')) return 'Video';
    if (mime.includes('audio/')) return 'Voice';

    return 'Document';
  }

  if (media.webpage && media.webpage.photo) {
    return 'Photo';
  }

  return 'Document';
}

/**
 * Helper to validate if a string is a valid URL starting with http/https.
 */
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/**
 * Extracts and maps URL buttons from Telegram inline keyboard.
 * Unsupported or callback buttons are ignored with warning logs.
 */
function extractButtons(message) {
  const buttons = [];
  if (config.convertTelegramButtons && message.replyMarkup && message.replyMarkup.rows) {
    for (const row of message.replyMarkup.rows) {
      const rowButtons = [];
      if (row.buttons) {
        for (const btn of row.buttons) {
          if (btn.url) {
            if (isValidUrl(btn.url)) {
              rowButtons.push({
                label: btn.text || 'Link',
                url: btn.url
              });
            } else {
              logger.warning(`Skipped button with invalid URL: ${btn.url}`);
            }
          } else if (btn.className === 'KeyboardButtonCallback' || btn.data) {
            logger.warning('Skipped Callback Button');
          } else {
            logger.warning(`Skipped unsupported button type: ${btn.className || typeof btn}`);
          }
        }
      }
      if (rowButtons.length > 0) {
        buttons.push(rowButtons);
      }
    }
  }
  return buttons;
}

/**
 * Attempts to resolve the sender's display name and username.
 */
async function getSenderInfo(client, message) {
  let displayName = 'Telegram User';
  let username = null;

  try {
    const sender = await message.getSender();
    if (sender) {
      if (sender.username) {
        username = sender.username;
      }
      
      // Compute best display name (first + last name, or title for channels/bots)
      const fullName = [sender.firstName, sender.lastName].filter(Boolean).join(' ');
      if (fullName) {
        displayName = fullName;
      } else if (sender.title) {
        displayName = sender.title;
      } else if (sender.username) {
        displayName = sender.username;
      }
    }
  } catch (err) {
    logger.warning(`Could not fetch sender details: ${err.message}. Using fallback.`);
  }

  // Fallback to post author name if it's a channel post
  if (displayName === 'Telegram User' && message.postAuthor) {
    displayName = message.postAuthor;
  }

  return { displayName, username };
}

/**
 * Formats and forwards a single message to Discord.
 */
async function processSingleMessage(client, message, chatName, isEdit = false) {
  try {
    if (!isEdit) {
      markAsForwarded(message.id);
    }

    const { displayName, username } = await getSenderInfo(client, message);
    const messageType = getMessageType(message);
    const buttons = extractButtons(message);

    const mediaPaths = [];
    if (config.downloadMedia && message.media) {
      const filePath = await downloadMedia(client, message);
      if (filePath) {
        mediaPaths.push(filePath);
      }
    }

    let text = message.message || '';
    if (isEdit) {
      text = `*(Edited)* ${text}`;
    }

    // Check if the Telegram message contains mention entities
    const hasMention = !!(message.entities && message.entities.some(e => 
      e.className === 'MessageEntityMention' || 
      e.className === 'MessageEntityMentionName'
    ));

    await sendToDiscord({
      text,
      senderName: displayName,
      senderUsername: username,
      groupName: chatName,
      timestamp: new Date(message.date * 1000),
      mediaPaths,
      hasMention,
      messageType,
      buttons
    });

    // Cleanup files if necessary
    if (mediaPaths.length > 0) {
      for (const path of mediaPaths) {
        cleanTempFile(path);
      }
    }
  } catch (err) {
    logger.error(`Error processing single message ID ${message.id}:`, err);
  }
}

/**
 * Consolidates and forwards multiple items belonging to the same Telegram album.
 */
async function processGroup(client, groupedId) {
  const group = groupedCache.get(groupedId);
  if (!group) return;

  // Clear from cache immediately to prevent racing
  groupedCache.delete(groupedId);

  const { messages, chatName } = group;

  try {
    logger.info(`Processing grouped album (Group ID: ${groupedId}, Items: ${messages.length})...`);

    // Sort by message ID to preserve chronological order
    messages.sort((a, b) => a.id - b.id);

    // Save states
    for (const msg of messages) {
      markAsForwarded(msg.id);
    }

    const { displayName, username } = await getSenderInfo(client, messages[0]);

    // Aggregate message/media types in the group
    const types = [...new Set(messages.map(m => getMessageType(m)))];
    const messageType = types.join(', ');

    // Extract all buttons across all messages in the group
    const buttons = [];
    for (const msg of messages) {
      const msgButtons = extractButtons(msg);
      if (msgButtons.length > 0) {
        buttons.push(...msgButtons);
      }
    }

    // Concatenate all captions (usually only one contains the text description)
    const captions = messages
      .map((m) => m.message)
      .filter(Boolean)
      .join('\n');

    // Download all media from the group
    const mediaPaths = [];
    if (config.downloadMedia) {
      for (const msg of messages) {
        if (msg.media) {
          const filePath = await downloadMedia(client, msg);
          if (filePath) {
            mediaPaths.push(filePath);
          }
        }
      }
    }

    // Check if any message in the album group contains mention entities
    const hasMention = messages.some(msg => 
      msg.entities && msg.entities.some(e => 
        e.className === 'MessageEntityMention' || 
        e.className === 'MessageEntityMentionName'
      )
    );

    await sendToDiscord({
      text: captions,
      senderName: displayName,
      senderUsername: username,
      groupName: chatName,
      timestamp: new Date(messages[0].date * 1000),
      mediaPaths,
      hasMention,
      messageType,
      buttons
    });

    // Cleanup files
    if (mediaPaths.length > 0) {
      for (const path of mediaPaths) {
        cleanTempFile(path);
      }
    }
  } catch (err) {
    logger.error(`Error processing message group ${groupedId}:`, err);
  }
}

/**
 * Handle new incoming message event.
 */
async function handleNewMessage(client, message, chatName) {
  if (isAlreadyForwarded(message.id)) {
    logger.info(`Message ID ${message.id} already forwarded. Skipping.`);
    return;
  }

  if (shouldIgnoreMessage(message)) {
    return;
  }

  // Handle grouped media (album)
  if (message.groupedId) {
    const groupedIdStr = message.groupedId.toString();

    if (groupedCache.has(groupedIdStr)) {
      const group = groupedCache.get(groupedIdStr);
      clearTimeout(group.timer);
      group.messages.push(message);

      group.timer = setTimeout(() => {
        processGroup(client, groupedIdStr).catch((err) =>
          logger.error(`Group processor failed for ${groupedIdStr}:`, err)
        );
      }, ALBUM_DEBOUNCE_MS);

      logger.info(`Added item to group queue (ID: ${message.id}, Group: ${groupedIdStr})`);
    } else {
      const group = {
        messages: [message],
        chatName,
        timer: setTimeout(() => {
          processGroup(client, groupedIdStr).catch((err) =>
            logger.error(`Group processor failed for ${groupedIdStr}:`, err)
          );
        }, ALBUM_DEBOUNCE_MS)
      };

      groupedCache.set(groupedIdStr, group);
      logger.info(`Initiated new group queue (ID: ${message.id}, Group: ${groupedIdStr})`);
    }
  } else {
    // Forward standard individual message
    await processSingleMessage(client, message, chatName, false);
  }
}

/**
 * Handle incoming edit event.
 */
async function handleEditedMessage(client, message, chatName) {
  if (shouldIgnoreMessage(message)) {
    return;
  }

  logger.info(`Forwarding edited message (ID: ${message.id})...`);
  await processSingleMessage(client, message, chatName, true);
}

module.exports = {
  handleNewMessage,
  handleEditedMessage
};
