require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 4000;

// Webhook route must receive the raw body buffer for HMAC-SHA256 signature verification.
// express.raw() is applied here before the global express.json() middleware so it takes
// precedence for this path only.
app.post('/webhook/clickup',
  express.raw({ type: 'application/json' }),
  require('./routes/clickup-webhook')
);

app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('ClickUp → Plextrac integration API is running.');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
