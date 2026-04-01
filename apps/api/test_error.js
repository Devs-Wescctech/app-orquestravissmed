const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    const run = await prisma.syncRun.findUnique({
        where: { id: '48b15a48-9712-4fac-b74f-d346d5b86a27' }
    });
    console.log(run?.metrics?.error?.substring(0, 300));
}

check().finally(() => prisma.$disconnect());
