const { PrismaClient } = require('@prisma/client');

async function main() {
    const prisma = new PrismaClient();

    // Get the real clinic
    const clinic = await prisma.clinic.findFirst();
    if (!clinic) { console.log('NO CLINIC!'); return; }
    console.log('CLINIC_ID=' + clinic.id);

    // Get connection
    const conn = await prisma.integrationConnection.findFirst({ where: { clinicId: clinic.id, provider: 'doctoralia' } });
    console.log('CONN_EXISTS=' + (!!conn));
    if (conn) console.log('HAS_CLIENT_ID=' + (!!conn.clientId));

    // Delete old mock mappings
    const deleted = await prisma.mapping.deleteMany({});
    console.log('DELETED_OLD_MAPPINGS=' + deleted.count);

    // Now trigger sync for the CORRECT clinicId
    const loginRes = await fetch('http://localhost:5000/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@vismed.com', password: 'admin123' })
    });
    const loginData = await loginRes.json();
    console.log('AUTH=' + (loginData.access_token ? 'OK' : 'FAIL'));

    const syncRes = await fetch('http://localhost:5000/sync/' + clinic.id + '/run', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + loginData.access_token }
    });
    const syncData = await syncRes.json();
    console.log('SYNC_RUN_ID=' + syncData.id);
    console.log('SYNC_STATUS=' + syncData.status);

    // Wait 15s for the BullMQ worker
    console.log('WAITING 15s...');
    await new Promise(r => setTimeout(r, 15000));

    // Check result
    const run = await prisma.syncRun.findUnique({ where: { id: syncData.id } });
    console.log('FINAL_STATUS=' + (run ? run.status : 'NOT_FOUND'));

    // Check new mappings
    const mappings = await prisma.mapping.findMany({ where: { clinicId: clinic.id, entityType: 'DOCTOR' } });
    console.log('NEW_DOCTOR_MAPPINGS=' + mappings.length);
    for (const m of mappings) {
        const name = m.conflictData ? m.conflictData.name : 'unknown';
        console.log('  DOCTOR: ' + name + ' extId=' + m.externalId + ' status=' + m.status);
    }

    await prisma.$disconnect();
}

main().catch(console.error);
