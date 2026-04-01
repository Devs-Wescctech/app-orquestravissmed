const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    const lastRun = await prisma.syncRun.findFirst({
        where: { type: 'full' },
        orderBy: { startedAt: 'desc' },
        include: { events: { orderBy: { timestamp: 'desc' }, take: 10 } }
    });

    console.log(`Last Doctoralia Sync: ${lastRun?.status} - ${lastRun?.startedAt}`);
    if (lastRun?.metrics?.error) console.log('Error:', lastRun.metrics.error);

    console.log('Events:');
    for (const ev of lastRun?.events || []) {
        console.log(`- ${ev.action}: ${ev.message}`);
    }

    const docs = await prisma.doctoraliaDoctor.findMany();
    console.log("\nDoctoralia Doctors in DB:");
    for (const d of docs) {
        console.log(`- ID: ${d.doctoraliaDoctorId} | Name: ${d.name}`);
    }

    const maps = await prisma.professionalUnifiedMapping.findMany({
        where: { isActive: true },
        include: { vismedDoctor: true, doctoraliaDoctor: true }
    });
    console.log(`\nActive ProfessionalUnifiedMappings: ${maps.length}`);
    for (const m of maps) {
        console.log(`- ${m.vismedDoctor.name} <==> ${m.doctoraliaDoctor.name}`);
    }
}
check().catch(console.error).finally(() => prisma.$disconnect());
