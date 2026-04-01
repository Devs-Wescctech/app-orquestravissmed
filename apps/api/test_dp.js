const axios = require('axios');
const crypto = require('crypto');

// Utilizando as configurações salvas em staging/db (ou testando sandbox puro)
const domain = 'doctoralia.com.br';
const clientId = '9hE9pT7X8L1Z6YkG5JpBvF4sV2wN1uS5iY9bJ4mO';
const clientSecret = 'X2pB0vF8sN4mO1uYZ3kG6iY9jT7hE1lC5pD8bR9qV3wX5zM2lA4sF7mP0nJ6h';
const facilityId = '249626';

function generateSignature(method, route, body) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomUUID();
    const data = body ? JSON.stringify(body) : '';
    const message = `${method.toUpperCase()}${route}?${data}${timestamp}${nonce}`;
    const hmac = crypto.createHmac('sha256', clientSecret);
    const signature = hmac.update(message).digest('base64');
    return { signature, timestamp, nonce };
}

async function requestLocal(endpoint) {
    const { signature, timestamp, nonce } = generateSignature('GET', endpoint, null);
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
            console.log(res.data);
        }
    } catch (e) {
        console.log(`Failed ${endpoint}:`, e.response?.data || e.message);
    }
}

async function run() {
    await requestLocal(`/facilities/${facilityId}/services`);
    await requestLocal(`/facilities/${facilityId}/insurances`);
}

run();
