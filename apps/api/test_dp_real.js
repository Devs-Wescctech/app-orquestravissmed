const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const crypto = require('crypto');

const prisma = new PrismaClient();

function generateSignature(clientSecret, method, route, body) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomUUID();
    const data = body ? JSON.stringify(body) : '';
    const message = `${method.toUpperCase()}${route}?${data}${timestamp}${nonce}`;
    const hmac = crypto.createHmac('sha256', clientSecret);
    const signature = hmac.update(message).digest('base64');
    return { signature, timestamp, nonce };
}

async function requestLocal(clientId, clientSecret, endpoint) {
    const { signature, timestamp, nonce } = generateSignature(clientSecret, 'GET', endpoint, null);
    try {
        const res = await axios.get(`https://www.doctoralia.com.br/api/v3${endpoint}`, {
            headers: {
                'Authorization': `Bearer ${clientId}:${signature}`,
                'X-Docplanner-Signature-Timestamp': timestamp,
                'X-Docplanner-Signature-Nonce': nonce
            }
        });
        console.log(`\n=== Response from ${endpoint} ===`);
        if (res.data && res.data._items && res.data._items.length > 0) {
            console.log(JSON.stringify(res.data._items[0], null, 2));
        } else {
            console.log(JSON.stringify(res.data, null, 2));
        }
    } catch (e) {
        console.log(`Failed ${endpoint}:`, e.response?.data || e.message);
    }
}

async function main() {
    const conn = await prisma.integrationConnection.findFirst({
        where: { clinicId: '36749174-fb55-4ef6-94de-2f24ea97dc57', provider: 'doctoralia' }
    });

    if (!conn) {
        console.log('No doctoralia connection found');
        return;
    }

    const { clientId, clientSecret } = conn;

    // Get Facility ID
    const { signature: sig, timestamp: ts, nonce: n } = generateSignature(clientSecret, 'GET', '/facilities', null);

    let facilityId = '249626'; // default
    try {
        const res = await axios.get(`https://www.doctoralia.com.br/api/v3/facilities`, {
            headers: {
                'Authorization': `Bearer ${clientId}:${sig}`,
                'X-Docplanner-Signature-Timestamp': ts,
                'X-Docplanner-Signature-Nonce': n
            }
        });
        if (res.data._items && res.data._items.length > 0) {
            facilityId = String(res.data._items[0].id);
            console.log('Using Facility ID:', facilityId);
        }
    } catch (e) {
        console.log('Failed fetching facilities');
    }

    await requestLocal(clientId, clientSecret, `/facilities/${facilityId}/services`);
    await requestLocal(clientId, clientSecret, `/facilities/${facilityId}/insurances`);
}

main().finally(() => prisma.$disconnect());
