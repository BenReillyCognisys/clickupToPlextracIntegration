require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 4000;

// Both webhook routes need raw body buffers for HMAC signature verification.
app.post('/webhook/clickup',
  express.raw({ type: 'application/json' }),
  require('./routes/clickup-webhook')
);

app.post('/webhook/plextrac',
  express.raw({ type: 'application/json' }),
  require('./routes/plextrac-webhook')
);

app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('ClickUp → Plextrac integration API is running.');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
