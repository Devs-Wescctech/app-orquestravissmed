const { PrismaClient } = require('@prisma/client');

async function main() {
    const prisma = new PrismaClient();

    const clinics = await prisma.clinic.findMany();
    for (const c of clinics) {
        console.log('CLINIC: id=' + c.id + ' name=' + c.name);
    }

    const conns = await prisma.integrationConnection.findMany();
    for (const c of conns) {
        console.log('CONN: id=' + c.id + ' clinicId=' + c.clinicId + ' provider=' + c.provider + ' hasKey=' + (!!c.clientId));
    }

    const mappings = await prisma.mapping.findMany({ where: { entityType: 'DOCTOR' } });
    for (const m of mappings) {
        const name = m.conflictData ? JSON.stringify(m.conflictData) : 'null';
        console.log('MAP: clinicId=' + m.clinicId + ' ext=' + m.externalId + ' status=' + m.status + ' data=' + name);
    }

    const roles = await prisma.userClinicRole.findMany();
    for (const r of roles) {
        console.log('ROLE: userId=' + r.userId + ' clinicId=' + r.clinicId + ' role=' + r.role);
    }

    const runs = await prisma.syncRun.findMany({ orderBy: { startedAt: 'desc' }, take: 3 });
    for (const r of runs) {
        console.log('RUN: id=' + r.id + ' clinicId=' + r.clinicId + ' status=' + r.status);
    }

    await prisma.$disconnect();
}

main().catch(console.error);
