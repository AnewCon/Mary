const https = require('https');

const TOKEN = '99u88E668mUe9660oCc6cOrU86EcEFOEa7tcR8u87e8u88Ug6mRtGwZ8mRA8M';

const payload = JSON.stringify({ token: TOKEN });

const options = {
    hostname: 'aa.aacc.icu',
    port: 443,
    path: '/api/getinfo',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
    }
};

console.log('正在向服务器发送请求...\n');

const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        const response = JSON.parse(data);
        console.log(`状态码: ${res.statusCode}`);
        console.log(`返回码: ${response.code}`);
        console.log(`消息: ${response.msg}`);
        
        if (response.data) {
            console.log('\n用户信息:');
            console.log(`  UID: ${response.data.uid}`);
            console.log(`  账号: ${response.data.user}`);
            console.log(`  昵称: ${response.data.name}`);
            console.log(`  余额: ${response.data.money}`);
            console.log(`  头像: https:${response.data.faceimg}`);
            if (response.data.addprice) {
                console.log(`  额外: ${response.data.addprice}`);
            }
        }
    });
});

req.on('error', (error) => {
    console.error(`请求失败: ${error.message}`);
});

req.write(payload);
req.end();
