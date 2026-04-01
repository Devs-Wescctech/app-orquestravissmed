const { PrismaClient } = require('@prisma/client');

async function main() {
    const prisma = new PrismaClient();
    const lines = [];

    // Find the IntegrationConnection's clinicId — this is the one that has the Doctoralia credentials
    const conn = await prisma.integrationConnection.findFirst({ where: { provider: 'doctoralia' } });
    if (!conn) {
        console.log('No IntegrationConnection found! Run seed first.');
        return;
    }

    const correctClinicId = conn.clinicId;
    lines.push('CORRECT_CLINIC_ID=' + correctClinicId);
    lines.push('CLIENT_ID=' + (conn.clientId || '').substring(0, 20));

    // Delete ALL old mappings
    const del = await prisma.mapping.deleteMany({});
    lines.push('DELETED_MAPPINGS=' + del.count);

    // Login
    const loginRes = await fetch('http://localhost:5000/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@vismed.com', password: 'admin123' })
    });
    const loginData = await loginRes.json();
    const token = loginData.access_token;
    lines.push('AUTH=' + (token ? 'OK' : 'FAIL'));

    // Trigger sync with the CORRECT clinic ID
    const syncRes = await fetch('http://localhost:5000/sync/' + correctClinicId + '/run', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token }
    });
    const syncData = await syncRes.json();
    lines.push('SYNC_ID=' + syncData.id);
    lines.push('SYNC_INITIAL_STATUS=' + syncData.status);

    // Wait 20s for BullMQ worker
    lines.push('WAITING_20s...');
    const fs = require('fs');
    fs.writeFileSync('/tmp/sync_progress.txt', lines.join('\n') + '\nIN_PROGRESS...');

    await new Promise(r => setTimeout(r, 20000));

    // Check result
    const run = await prisma.syncRun.findUnique({ where: { id: syncData.id } });
    lines.push('FINAL_STATUS=' + (run ? run.status : 'NOT_FOUND'));
    if (run && run.metrics) {
        lines.push('METRICS=' + JSON.stringify(run.metrics));
    }

    // Check mappings
    const mappings = await prisma.mapping.findMany({ where: { clinicId: correctClinicId, entityType: 'DOCTOR' } });
    lines.push('DOCTOR_MAPPINGS=' + mappings.length);
    for (const m of mappings) {
        const name = m.conflictData ? m.conflictData.name : 'unknown';
        lines.push('  DOCTOR: ' + name + ' (extId=' + m.externalId + ', status=' + m.status + ')');
    }

    fs.writeFileSync('/tmp/sync_result.txt', lines.join('\n'));
    console.log('Results written to /tmp/sync_result.txt');

    await prisma.$disconnect();
}

main().catch(console.error);
