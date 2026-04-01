const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';

async function run() {
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

    // 1. Delete the test service we just added (ID 5934105 and 5934106)
    for (const svcId of ['5934105', '5934106']) {
        const delUrl = `https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}/services/${svcId}`;
        const delRes = await fetch(delUrl, { method: 'DELETE', headers });
        console.log('DELETE ' + svcId + ': ' + delRes.status);
    }

    // 2. Fetch dictionary - try with retry and delay
    console.log('\nFetching dictionary...');
    await new Promise(r => setTimeout(r, 2000));
    const catUrl = `https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/services`;
    const catRes = await fetch(catUrl, { headers });
    console.log('Dictionary status: ' + catRes.status);

    if (catRes.ok) {
        const data = await catRes.json();
        const items = data._items || [];
        console.log('Total dictionary items: ' + items.length);

        // Search for our target specialties
        const targets = ['cardiologia', 'clinico geral', 'oftalmologia'];
        for (const target of targets) {
            const matches = items.filter(i => i.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(target));
            console.log('\n"' + target + '" matches:');
            matches.slice(0, 10).forEach(m => console.log('  ID:' + m.id + ' - ' + m.name));
        }

        // Save full catalog
        const fs = require('fs');
        fs.writeFileSync('full_catalog.json', JSON.stringify(items, null, 2));
        console.log('\nSaved full catalog to full_catalog.json');
    } else {
        // If catalog still fails, try adding various IDs to find Cardiologia
        console.log('Dictionary not available. Trying brute-force search...');
        // The IDs from the earlier successful fetch were in the 10000-11000 range
        // Let's test a few service_ids to find cardiologia
        const testIds = ['2', '3', '4', '5', '10', '20', '50', '100', '200', '500'];
        for (const testId of testIds) {
            const tUrl = `https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}/services`;
            const tRes = await fetch(tUrl, { method: 'POST', headers, body: JSON.stringify({ service_id: testId, is_visible: true }) });
            if (tRes.status === 201) {
                const tData = await tRes.json();
                console.log('ID ' + testId + ' -> ' + tData.name + ' (addr_svc_id: ' + tData.id + ')');
                // Delete immediately
                await fetch(`${tUrl}/${tData.id}`, { method: 'DELETE', headers });
            } else {
                console.log('ID ' + testId + ' -> Status ' + tRes.status);
            }
        }
    }
}

run().catch(console.error);
