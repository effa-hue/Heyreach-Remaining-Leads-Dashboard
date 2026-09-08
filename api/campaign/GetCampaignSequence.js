module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-KEY');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Unlike the other HeyReach endpoints this one is a GET with a query parameter.
  try {
    const campaignId = req.query?.campaignId ?? '';
    const url = 'https://api.heyreach.io/api/public/campaign/GetCampaignSequence?campaignId='
      + encodeURIComponent(campaignId);
    const response = await fetch(url, {
      headers: {
        ...(req.headers['x-api-key'] ? { 'X-API-KEY': req.headers['x-api-key'] } : {}),
      },
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};
