/**
 * Logger utility with ANSI colors and timestamps.
 */

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function getTimestamp() {
  return new Date().toISOString();
}

function info(message, ...args) {
  console.log(`${COLORS.bold}[${getTimestamp()}]${COLORS.reset} ${COLORS.blue}[INFO]${COLORS.reset} ${message}`, ...args);
}

function success(message, ...args) {
  console.log(`${COLORS.bold}[${getTimestamp()}]${COLORS.reset} ${COLORS.green}[SUCCESS]${COLORS.reset} ${message}`, ...args);
}

function warning(message, ...args) {
  console.warn(`${COLORS.bold}[${getTimestamp()}]${COLORS.reset} ${COLORS.yellow}[WARNING]${COLORS.reset} ${message}`, ...args);
}

function error(message, err) {
  const errMsg = err && err.stack ? err.stack : err || '';
  console.error(`${COLORS.bold}[${getTimestamp()}]${COLORS.reset} ${COLORS.red}[ERROR]${COLORS.reset} ${message}`, errMsg);
}

function forward(senderName, details) {
  console.log(`${COLORS.bold}[${getTimestamp()}]${COLORS.reset} ${COLORS.magenta}[FORWARD]${COLORS.reset} ${senderName}`);
  console.log(`Buttons: ${details.buttons}`);
  console.log(`Media: ${details.media}`);
  console.log(`Discord Message ID: ${details.discordMessageId}`);
}

module.exports = {
  info,
  success,
  warning,
  error,
  forward
};
