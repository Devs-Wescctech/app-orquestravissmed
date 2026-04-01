const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    const docCount = await prisma.doctoraliaDoctor.count();
    const mapCount = await prisma.professionalUnifiedMapping.count({ where: { isActive: true } });
    const srvCount = await prisma.doctoraliaService.count();
    const specSrvCount = await prisma.specialtyServiceMapping.count();

    console.log(`\nNew Schema Stats:
    - Doctors: ${docCount}
    - Unified Mappings HQ (Doctors): ${mapCount}
    - Services: ${srvCount}
    - Specialty Mappings: ${specSrvCount}`);
}

check().catch(console.error).finally(() => prisma.$disconnect());
