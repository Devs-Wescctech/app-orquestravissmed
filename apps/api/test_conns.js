const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    const conns = await prisma.integrationConnection.findMany({ where: { provider: 'doctoralia' } });
    console.log(JSON.stringify(conns, null, 2));
}
check().catch(console.error).finally(() => prisma.$disconnect());
