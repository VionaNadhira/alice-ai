/**
 * State manager to prevent forwarding duplicate messages.
 * Stores data in data/state.json.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const STATE_FILE_PATH = path.resolve(__dirname, '../data/state.json');
const MAX_HISTORY_LENGTH = 1000;

// Default initial state
const defaultState = {
  forwardedIds: []
};

// Current cached state
let stateCache = { ...defaultState };

/**
 * Initializes and loads the state file.
 */
function loadState() {
  try {
    const dir = path.dirname(STATE_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(STATE_FILE_PATH)) {
      const data = fs.readFileSync(STATE_FILE_PATH, 'utf8');
      stateCache = JSON.parse(data);
      if (!Array.isArray(stateCache.forwardedIds)) {
        stateCache.forwardedIds = [];
      }
    } else {
      saveState(defaultState);
    }
  } catch (err) {
    logger.error('Failed to load state.json, using default state.', err);
    stateCache = { ...defaultState };
  }
  return stateCache;
}

/**
 * Saves state to data/state.json.
 */
function saveState(newState) {
  try {
    const dir = path.dirname(STATE_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    stateCache = newState;
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(stateCache, null, 2), 'utf8');
  } catch (err) {
    logger.error('Failed to save state.json', err);
  }
}

/**
 * Checks if a message ID has already been forwarded.
 * @param {number} messageId - The Telegram message ID.
 * @returns {boolean} True if already forwarded.
 */
function isAlreadyForwarded(messageId) {
  return stateCache.forwardedIds.includes(messageId);
}

/**
 * Marks a message ID as forwarded.
 * @param {number} messageId - The Telegram message ID.
 */
function markAsForwarded(messageId) {
  // Prevent duplicate insertion in cache
  if (stateCache.forwardedIds.includes(messageId)) return;

  stateCache.forwardedIds.push(messageId);

  // Keep list size within limit to prevent state file growing indefinitely
  if (stateCache.forwardedIds.length > MAX_HISTORY_LENGTH) {
    stateCache.forwardedIds.shift();
  }

  saveState(stateCache);
}

module.exports = {
  loadState,
  isAlreadyForwarded,
  markAsForwarded
};
