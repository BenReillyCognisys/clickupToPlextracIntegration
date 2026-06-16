const express = require('express');
const app = express();
const PORT = process.env.PORT || 4000;

app.get('/', (req, res) => {
  res.status(200).send('ClickUp → Plextrac integration API is running.');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
