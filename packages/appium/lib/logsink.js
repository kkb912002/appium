import {AsyncLocalStorage} from 'async_hooks';
import npmlog from 'npmlog';
import {createLogger, format, transports} from 'winston';
import {fs, logger} from '@appium/support';
import { APPIUM_LOGGER_NAME } from './logger';
import LRUCache from 'lru-cache';
import _ from 'lodash';

// set up distributed logging before everything else
logger.patchLogger(npmlog);
global._global_npmlog = npmlog;
global._global_log_context = new AsyncLocalStorage();

// npmlog is used only for emitting, we use winston for output
npmlog.level = 'info';
const levels = {
  debug: 4,
  info: 3,
  warn: 2,
  error: 1,
};

const colors = {
  info: 'cyan',
  debug: 'grey',
  warn: 'yellow',
  error: 'red',
};

const npmToWinstonLevels = {
  silly: 'debug',
  verbose: 'debug',
  debug: 'debug',
  info: 'info',
  http: 'info',
  warn: 'warn',
  error: 'error',
};

/** @type {Map<string, number>} */
const prefixColorMap = new Map();

/** @type {LRUCache<string, number>} */
const sessionColorCache = new LRUCache({
  ttl: 24 * 60 * 60 * 1000,
});

let log = null;
let useLocalTimeZone = false;

// add the timestamp in the correct format to the log info object
const timestampFormat = format.timestamp({
  format() {
    let date = new Date();
    if (useLocalTimeZone) {
      date = new Date(date.valueOf() - date.getTimezoneOffset() * 60000);
    }
    // '2012-11-04T14:51:06.157Z' -> '2012-11-04 14:51:06:157'
    return date.toISOString().replace(/[TZ]/g, ' ').replace(/\./g, ':').trim();
  },
});

// set the custom colors
const colorizeFormat = format.colorize({
  colors,
});

// Strip the color marking within messages
const stripColorFormat = format(function stripColor(info) {
  const code = /\u001b\[(\d+(;\d+)*)?m/g; // eslint-disable-line no-control-regex
  info.message = info.message.replace(code, '');
  return info;
})();

function createConsoleTransport(args, logLvl) {
  return new transports.Console({
    // @ts-expect-error The 'name' property should exist
    name: 'console',
    handleExceptions: true,
    exitOnError: false,
    json: false,
    level: logLvl,
    stderrLevels: ['error'],
    format: format.combine(
      timestampFormat,
      args.logNoColors ? stripColorFormat : colorizeFormat,
      format.printf(function printInfo(info) {
        return `${args.logTimestamp ? `${info.timestamp} - ` : ''}${info.message}`;
      })
    ),
  });
}

function createFileTransport(args, logLvl) {
  return new transports.File({
    // @ts-expect-error The 'name' property should exist
    name: 'file',
    filename: args.logFile,
    maxFiles: 1,
    handleExceptions: true,
    exitOnError: false,
    json: false,
    level: logLvl,
    format: format.combine(
      stripColorFormat,
      timestampFormat,
      format.printf(function printInfo(info) {
        return `${info.timestamp} ${info.message}`;
      })
    ),
  });
}

function createHttpTransport(args, logLvl) {
  let host = '127.0.0.1';
  let port = 9003;

  if (args.webhook.match(':')) {
    const hostAndPort = args.webhook.split(':');
    host = hostAndPort[0];
    port = parseInt(hostAndPort[1], 10);
  }

  return new transports.Http({
    // @ts-expect-error The 'name' property should exist
    name: 'http',
    host,
    port,
    path: '/',
    handleExceptions: true,
    exitOnError: false,
    json: false,
    level: logLvl,
    format: format.combine(
      stripColorFormat,
      format.printf(function printInfo(info) {
        return `${info.timestamp} ${info.message}`;
      })
    ),
  });
}

/**
 *
 * @param {import('@appium/types').StringRecord} args
 * @returns {Promise<import('winston-transport')[]>}
 */
async function createTransports(args) {
  const transports = [];
  let consoleLogLevel = null;
  let fileLogLevel = null;

  if (args.loglevel && args.loglevel.match(':')) {
    // --log-level arg can optionally provide diff logging levels for console and file, separated by a colon
    const lvlPair = args.loglevel.split(':');
    consoleLogLevel = lvlPair[0] || consoleLogLevel;
    fileLogLevel = lvlPair[1] || fileLogLevel;
  } else {
    consoleLogLevel = fileLogLevel = args.loglevel;
  }

  transports.push(createConsoleTransport(args, consoleLogLevel));

  if (args.logFile) {
    try {
      // if we don't delete the log file, winston will always append and it will grow infinitely large;
      // winston allows for limiting log file size, but as of 9.2.14 there's a serious bug when using
      // maxFiles and maxSize together. https://github.com/flatiron/winston/issues/397
      if (await fs.exists(args.logFile)) {
        await fs.unlink(args.logFile);
      }

      transports.push(createFileTransport(args, fileLogLevel));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(
        `Tried to attach logging to file '${args.logFile}' but an error ` + `occurred: ${e.message}`
      );
    }
  }

  if (args.webhook) {
    try {
      transports.push(createHttpTransport(args, fileLogLevel));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(
        `Tried to attach logging to Http at ${args.webhook} but ` +
          `an error occurred: ${e.message}`
      );
    }
  }

  return transports;
}

/**
 * @param {string} text
 * @param {number} colorNumber 0-255
 * @returns {string}
 */
function colorizeText(text, colorNumber) {
  return `\x1b[38;5;${colorNumber}m${text}\x1b[0m`;
}

/**
 * @param {string} prefix
 * @returns {string}
 */
function getColorizedPrefix(prefix) {
  let prefixId = prefix.split('@')[0].trim();
  prefixId = prefixId.split(' (')[0].trim();
  let colorNumber = prefixColorMap.get(prefixId);
  if (!_.isNumber(colorNumber)) {
    // using a multiple of 16 should cause 16 colors to be created
    colorNumber = (prefixColorMap.size * 16) % 256;
    prefixColorMap.set(prefixId, colorNumber);
  }
  // use the modulus to cycle around color wheel
  return colorizeText(prefix, colorNumber);
}

/**
 * @param {string} session
 * @param {boolean} noColor
 * @returns {string}
 */
const getFormattedSession = (() => {
  let idx = 0;
  /**
   * @param {string} session
   * @param {boolean} noColor
   * @returns {string}
   */
  return (session, noColor) => {
    let stripped = `[${session.substring(0, 8)}]`;

    if (noColor) {
      return stripped;
    }

    let colorNumber = sessionColorCache.get(session);
    if (!_.isNumber(colorNumber)) {
      colorNumber = (idx++ * 16 + 8) % 256;
      sessionColorCache.set(session, colorNumber);
    }

    return colorizeText(stripped, colorNumber);
  };
})();

async function init(args) {
  npmlog.level = 'silent';

  // set de facto param passed to timestamp function
  useLocalTimeZone = args.localTimezone;

  // clean up in case we have initiated before since npmlog is a global object
  clear();

  const transports = await createTransports(args);
  const transportNames = new Set(transports.map((tr) => tr.constructor.name));
  log = createLogger({
    transports,
    levels,
  });

  const reportedLoggerErrors = new Set();
  // Capture logs emitted via npmlog and pass them through winston
  npmlog.on('log', ({level, message, prefix}) => {
    const winstonLevel = npmToWinstonLevels[level] || 'info';
    let header = '';
    // args.logContext
    let args_logContext = true;
    if (args_logContext) {
      const contextStorage = global._global_log_context;
      if (contextStorage) {
        const {request: r, session: s} = contextStorage.getStore() ?? {};
        const r_short = r ? `[${r?.substring(0, 8)}]` : '';
        const s_short = s ? getFormattedSession(s, args.logNoColors) : '';
        header += r && s ? r_short + s_short : r ? r_short : '';
      }
    }
    if (prefix) {
      const decoratedPrefix = `[${prefix}]`;
      const toColorizedDecoratedPrefix = () => prefix === APPIUM_LOGGER_NAME
          ? decoratedPrefix.magenta
          : getColorizedPrefix(decoratedPrefix);
      header += args.logNoColors ? decoratedPrefix : toColorizedDecoratedPrefix();
    }

    const msg = header ? `${header} ${message}` : message;
    try {
      log[winstonLevel](msg);
      if (_.isFunction(args.logHandler)) {
        args.logHandler(level, msg);
      }
    } catch (e) {
      if (!reportedLoggerErrors.has(e.message) && process.stderr.writable) {
        // eslint-disable-next-line no-console
        console.error(
          `The log message '${_.truncate(msg, {length: 30})}' cannot be written into ` +
            `one or more requested destinations: ${transportNames}. Original error: ${e.message}`
        );
        reportedLoggerErrors.add(e.message);
      }
    }
  });
}

function clear() {
  if (log) {
    for (let transport of _.keys(log.transports)) {
      log.remove(transport);
    }
  }
  npmlog.removeAllListeners('log');
}

export {init, clear};
export default init;
