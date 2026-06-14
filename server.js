const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(__dirname));

function sendRequest(endpoint, data) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(data);
        const options = {
            hostname: 'aa.aacc.icu',
            port: 443,
            path: endpoint,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => { responseData += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(responseData));
                } catch (e) {
                    resolve({ code: -1, msg: '响应解析失败', raw: responseData });
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.write(payload);
        req.end();
    });
}

app.post('/api/getinfo', async (req, res) => {
    try {
        const { token } = req.body;
        const result = await sendRequest('/api/getinfo', { token });
        res.json(result);
    } catch (error) {
        res.json({ code: -1, msg: `请求失败: ${error.message}` });
    }
});

app.post('/api/get', async (req, res) => {
    try {
        const { token, platform, user, pass } = req.body;
        const result = await sendRequest('/api/get', { token, platform, user, pass });
        res.json(result);
    } catch (error) {
        res.json({ code: -1, msg: `请求失败: ${error.message}` });
    }
});

app.post('/api/add', async (req, res) => {
    try {
        const { token, platform, user, pass, kcname, kcid } = req.body;
        const data = { token, platform, user, pass, kcname };
        if (kcid !== undefined && kcid !== '') {
            data.kcid = kcid;
        }
        const result = await sendRequest('/api/add', data);
        res.json(result);
    } catch (error) {
        res.json({ code: -1, msg: `请求失败: ${error.message}` });
    }
});

app.listen(PORT, () => {
    console.log(`服务器已启动: http://localhost:${PORT}`);
});
