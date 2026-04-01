const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const conn = await prisma.integrationConnection.findFirst({ select: { domain: true } });
    console.log(JSON.stringify(conn, null, 2));
}

main().catch(err => console.error(err)).finally(() => prisma.$disconnect());
