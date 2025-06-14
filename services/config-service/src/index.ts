import app from './server';

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Config service running on port ${PORT}`);
});
