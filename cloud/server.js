// Local cloud server (no Vercel needed): API + dashboard on one port, SQLite unless DATABASE_URL is set.
require('../shared/common').loadLocalEnv(); // must run before ./app reads process.env
const path = require('node:path');
const express = require('express');
const api = require('./app');
const { log } = require('../shared/common');

const PORT = Number(process.env.CLOUD_HTTP_PORT || process.env.PORT || 3000);
const app = express();
app.use(api);
app.use(express.static(path.join(__dirname, '..', 'public')));
app.listen(PORT, () => log('cloud', `dashboard + API on http://localhost:${PORT}`));
