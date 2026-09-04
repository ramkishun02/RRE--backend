app.get("/test-algoip", async (req, res) => {
  try {
    const response = await kiteFetch("https://api.kite.trade/instruments/NSE", {
      method: "GET",
      headers: {
        "X-Kite-Version": "3",
        Authorization: `token ${KITE_API_KEY}:${(await getKiteToken()).accesstoken}`
      }
    });

    const text = await response.text();

    return res.json({
      success: true,
      status: response.status,
      length: text.length
    });
  } catch (error) {
    return res.json({
      success: false,
      message: error.message,
      code: error.code
    });
  }
});