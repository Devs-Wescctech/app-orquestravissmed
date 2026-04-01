import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const mappings = await prisma.mapping.findMany({
        where: { entityType: 'DOCTOR' }
    });
    console.log('--- DOCTORS MAPPINGS IN DB ---');
    console.log(JSON.stringify(mappings, null, 2));

    const clinics = await prisma.clinic.findMany();
    console.log('--- CLINICS ---');
    console.log(JSON.stringify(clinics, null, 2));

    const conns = await prisma.integrationConnection.findMany();
    console.log('--- CONNS ---');
    console.log(JSON.stringify(conns, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
