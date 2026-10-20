require('dotenv').config({ quiet: true });

const { createApp } = require('./app');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

const instance = createApp();
const server = instance.app.listen(port, host, () => {
  console.log('Allen Cleaning Supervisor running at http://' + host + ':' + port);
  console.log('Database: ' + instance.config.dbPath);
  console.log('Uploads:  ' + instance.config.uploadDir);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n' + signal + ' received. Closing server...');
  server.close(() => {
    instance.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
