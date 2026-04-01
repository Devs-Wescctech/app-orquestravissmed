const { PrismaClient } = require('@prisma/client');

async function main() {
    const prisma = new PrismaClient();

    const run = await prisma.syncRun.findFirst({ orderBy: { startedAt: 'desc' } });
    if (run) {
        console.log('LATEST_RUN_STATUS=' + run.status);
        console.log('LATEST_RUN_CLINIC=' + run.clinicId);
        if (run.metrics) {
            console.log('METRICS_ERROR=' + JSON.stringify(run.metrics));
        } else {
            console.log('NO_METRICS');
        }
    }

    // Also check if connection clinicId matches
    const clinic = await prisma.clinic.findFirst();
    if (clinic) {
        console.log('CLINIC_ID=' + clinic.id);
        const conn = await prisma.integrationConnection.findFirst({ where: { clinicId: clinic.id } });
        if (conn) {
            console.log('CONN_MATCH=true');
            console.log('CLIENT_ID_STARTS=' + (conn.clientId || '').substring(0, 10));
            console.log('SECRET_STARTS=' + (conn.clientSecret || '').substring(0, 10));
            console.log('DOMAIN=' + conn.domain);
        } else {
            console.log('CONN_MATCH=false');
            // Check if there is ANY connection
            const anyConn = await prisma.integrationConnection.findFirst();
            if (anyConn) {
                console.log('FOUND_CONN_FOR_CLINIC=' + anyConn.clinicId);
            }
        }
    }

    await prisma.$disconnect();
}

main().catch(console.error);
