export async function onRequestPost({ request }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  try {
    const { account, password, platform, kcname, kcid } = await request.json();

    const data = { 
      token: '99u88E668mUe9660oCc6cOrU86EcEFOEa7tcR8u87e8u88Ug6mRtGwZ8mRA8M', 
      platform, 
      user: account, 
      pass: password, 
      kcname 
    };
    if (kcid) data.kcid = kcid;

    const response = await fetch('https://aa.aacc.icu/api/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    const result = await response.json();

    return new Response(JSON.stringify(result), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: '请求失败', message: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}