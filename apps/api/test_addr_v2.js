const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';

async function test() {
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

    // Get current address
    const getRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}`, { headers });
    const addr = await getRes.json();
    const fs = require('fs');
    fs.writeFileSync('current_address.json', JSON.stringify(addr, null, 2));
    console.log('Saved current address');
    console.log('Insurance flag: ' + (addr.booking_extra_fields ? addr.booking_extra_fields.insurance : 'N/A'));

    const results = [];

    // Test 1: PATCH with insuranceSupport: []
    let r = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}`, {
        method: 'PATCH', headers, body: JSON.stringify({ name: 'Test1', insuranceSupport: [] })
    });
    results.push('Test1 (insuranceSupport:[]): ' + r.status + ' ' + await r.text());

    // Test 2: PATCH with only name
    r = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}`, {
        method: 'PATCH', headers, body: JSON.stringify({ name: 'Test2' })
    });
    results.push('Test2 (name only): ' + r.status + ' ' + await r.text());

    // Test 3: PUT with full address object minus insurance fields
    const { booking_extra_fields, ...addrClean } = addr;
    addrClean.name = 'Test3';
    r = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}`, {
        method: 'PUT', headers, body: JSON.stringify(addrClean)
    });
    results.push('Test3 (PUT clean): ' + r.status + ' ' + (await r.text()).substring(0, 200));

    // Test 4: PUT with full address object including booking_extra_fields with insurance: false
    const addrFull = { ...addr, name: 'Test4', booking_extra_fields: { ...addr.booking_extra_fields, insurance: false } };
    r = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}`, {
        method: 'PUT', headers, body: JSON.stringify(addrFull)
    });
    results.push('Test4 (PUT full+ins:false): ' + r.status + ' ' + (await r.text()).substring(0, 200));

    fs.writeFileSync('patch_results.txt', results.join('\n\n'));
    console.log('\nResults saved to patch_results.txt');
    results.forEach(r => console.log(r.substring(0, 120)));
}

test().catch(console.error);
