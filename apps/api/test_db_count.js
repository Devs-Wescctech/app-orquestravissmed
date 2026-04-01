const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    const lastRun = await prisma.syncRun.findFirst({
        where: { type: 'full' },
        orderBy: { startedAt: 'desc' },
        include: { events: { orderBy: { timestamp: 'desc' }, take: 5 } }
    });
    console.log(`Last Doctoralia Sync: ${lastRun?.status} - ${lastRun?.startedAt}`);
    if (lastRun?.metrics?.error) console.log('Error:', lastRun.metrics.error);

    for (const ev of lastRun?.events || []) {
        console.log(`- ${ev.action}: ${ev.message}`);
    }

    const docCount = await prisma.doctoraliaDoctor.count();
    const mapCount = await prisma.mapping.count({ where: { status: 'LINKED', entityType: 'DOCTOR' } });
    const srvCount = await prisma.doctoraliaService.count();
    const specSrvCount = await prisma.specialtyServiceMapping.count();

    console.log(`\nStats:
    - Doctors: ${docCount}
    - Linked Mapping (Doctors): ${mapCount}
    - Services: ${srvCount}
    - Specialty Matches: ${specSrvCount}`);
}

check().catch(console.error).finally(() => prisma.$disconnect());
