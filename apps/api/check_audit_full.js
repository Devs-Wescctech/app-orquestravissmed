const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const latestLogs = await prisma.auditLog.findMany({
    orderBy: { timestamp: 'desc' },
    take: 10
  });

  console.log(JSON.stringify(latestLogs, null, 2));
  await prisma.$disconnect();
}

check();
