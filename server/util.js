class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function wrap(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requireText(value, field, { min = 1, max = 500 } = {}) {
  if (typeof value !== 'string') {
    throw new HttpError(400, field + ' is required.');
  }
  const text = value.trim();
  if (text.length < min) {
    throw new HttpError(400, field + ' is required.');
  }
  if (text.length > max) {
    throw new HttpError(400, field + ' is too long (maximum ' + max + ' characters).');
  }
  return text;
}

function optionalText(value, field, { max = 2000 } = {}) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new HttpError(400, field + ' must be text.');
  }
  const text = value.trim();
  if (text.length > max) {
    throw new HttpError(400, field + ' is too long (maximum ' + max + ' characters).');
  }
  return text;
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 2000 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function requireDate(value, field = 'Date') {
  if (!isValidDate(value)) {
    throw new HttpError(400, field + ' must be a valid date (YYYY-MM-DD).');
  }
  return value;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function todayLocal() {
  const date = new Date();
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function addDays(dateString, amount) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
}

function toBool(value) {
  return value === true || value === 1 || value === '1';
}

module.exports = {
  HttpError,
  wrap,
  requireText,
  optionalText,
  isValidDate,
  requireDate,
  todayLocal,
  addDays,
  toBool
};
