const https = require('https');
const axios = require('axios');

async function test() {
    try {
        const authData = 'grant_type=client_credentials&scope=integration&client_id=141121&client_secret=vismed2025';
        const res = await axios.post('https://www.doctoralia.com.br/oauth/v2/token', authData, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });
        const token = res.data.access_token;
        console.log("Authenticated!");

        const docsRes = await axios.get('https://www.doctoralia.com.br/api/v3/facilities/241076/doctors', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const doc = docsRes.data._items[0];
        console.log("\nFull Doctor Payload:");
        console.log(JSON.stringify(doc, null, 2));

    } catch (e) {
        console.error(e.response ? e.response.data : e.message);
    }
}
test();
