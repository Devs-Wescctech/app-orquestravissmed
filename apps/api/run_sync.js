const { PrismaClient } = require('@prisma/client');

async function main() {
    const prisma = new PrismaClient();

    // 1. Find the actual clinic
    const clinics = await prisma.clinic.findMany();
    console.log('CLINICS:', JSON.stringify(clinics.map(c => ({ id: c.id, name: c.name }))));

    if (clinics.length === 0) {
        console.log('No clinics found!');
        return;
    }

    const clinicId = clinics[0].id;
    console.log('Using clinicId:', clinicId);

    // 2. Check integration connection
    const conn = await prisma.integrationConnection.findFirst({
        where: { clinicId, provider: 'doctoralia' }
    });
    console.log('CONN:', conn ? { id: conn.id, clientId: conn.clientId ? conn.clientId.substring(0, 15) + '...' : null } : 'NONE');

    // 3. Login to get JWT
    const loginRes = await fetch('http://localhost:5000/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@vismed.com', password: 'admin123' })
    });
    const loginData = await loginRes.json();
    console.log('LOGIN:', loginData.access_token ? 'OK (got token)' : 'FAIL');

    if (!loginData.access_token) {
        console.log('Login failed:', loginData);
        return;
    }

    // 4. Trigger sync
    const syncRes = await fetch(`http://localhost:5000/sync/${clinicId}/run`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${loginData.access_token}` }
    });
    const syncData = await syncRes.json();
    console.log('SYNC TRIGGERED:', JSON.stringify(syncData));

    // 5. Wait 10 seconds for worker to process
    console.log('Waiting 10s for BullMQ worker...');
    await new Promise(r => setTimeout(r, 10000));

    // 6. Check sync events
    const events = await prisma.syncEvent.findMany({
        where: { syncRunId: syncData.id },
        orderBy: { createdAt: 'asc' }
    });
    console.log('EVENTS:', JSON.stringify(events, null, 2));

    // 7. Check mappings
    const mappings = await prisma.mapping.findMany({
        where: { clinicId, entityType: 'DOCTOR' }
    });
    console.log('DOCTOR MAPPINGS:', mappings.length);
    mappings.forEach(m => {
        const name = m.conflictData && m.conflictData.name ? m.conflictData.name : 'unknown';
        console.log(`  - ${name} (externalId: ${m.externalId}, status: ${m.status})`);
    });

    // 8. Check final sync run status
    const run = await prisma.syncRun.findUnique({ where: { id: syncData.id } });
    console.log('FINAL STATUS:', run ? run.status : 'NOT FOUND');

    await prisma.$disconnect();
}

main().catch(console.error);
