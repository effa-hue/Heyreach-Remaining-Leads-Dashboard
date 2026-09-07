module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-KEY');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const response = await fetch('https://api.heyreach.io/api/public/li_account/GetAll', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers['x-api-key'] ? { 'X-API-KEY': req.headers['x-api-key'] } : {}),
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};
