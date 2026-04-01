const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const latestLogs = await prisma.auditLog.findMany({
    where: {
      action: { in: ['FETCH_SLOTS', 'FETCH_BOOKINGS'] }
    },
    orderBy: { timestamp: 'desc' },
    take: 5
  });

  console.log(JSON.stringify(latestLogs, null, 2));
  await prisma.$disconnect();
}

check();
