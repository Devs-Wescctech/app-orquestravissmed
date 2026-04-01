const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';
const fs = require('fs');

async function testApi() {
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
        body: 'grant_type=client_credentials&scope=integration'
    });
    const { access_token } = await tokenRes.json();
    const headers = { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' };

    const facilityId = '140548';
    const docId = '1396868';
    const addrId = '1750984';

    // 1. Get current address services
    console.log('=== SERVIÇOS ATUAIS DO MÉDICO NO ENDEREÇO ===');
    const svcRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}/services`, { headers });
    const svcs = await svcRes.json();
    console.log(JSON.stringify(svcs, null, 2));

    // 2. Try to get facility-level service catalog
    console.log('\n=== CATÁLOGO DE SERVIÇOS DA FACILITY ===');
    const catRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/services`, { headers });
    console.log('Catalog Status:', catRes.status);
    if (catRes.ok) {
        const cat = await catRes.json();
        console.log(JSON.stringify(cat, null, 2));
    } else {
        console.log('Catalog body:', await catRes.text());
    }

    // 3. Try to get global services list
    console.log('\n=== SERVIÇOS GLOBAIS ===');
    const globalRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/services`, { headers });
    console.log('Global Status:', globalRes.status);
    if (globalRes.ok) {
        const global = await globalRes.json();
        console.log(JSON.stringify(global, null, 2));
    } else {
        console.log('Global body:', await globalRes.text());
    }

    // 4. Try to delete one existing service to see format
    if (svcs._items && svcs._items.length > 0) {
        const testSvc = svcs._items[0];
        console.log(`\n=== TENTATIVA DE DELETE: Service ${testSvc.id} ===`);
        const delRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}/services/${testSvc.id}`, { method: 'DELETE', headers });
        console.log('DELETE Status:', delRes.status);
        if (delRes.status !== 204) {
            console.log('DELETE body:', await delRes.text());
        } else {
            console.log('DELETE OK (204 No Content)');
        }
    }
}

testApi().catch(console.error);
