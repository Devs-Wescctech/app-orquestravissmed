const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const latestLogs = await prisma.auditLog.findMany({
    where: {
      action: { in: ['FETCH_SLOTS', 'FETCH_BOOKINGS'] },
      details: { path: ['status'], equals: 'error' }
    },
    orderBy: { timestamp: 'desc' },
    take: 5
  });

  latestLogs.forEach(log => {
      console.log(`Action: ${log.action}, Timestamp: ${log.timestamp}`);
      console.log(`Error: ${log.details.error}`);
      console.log(`API Response: ${log.details.details || 'N/A'}`);
      console.log('---');
  });
  
  await prisma.$disconnect();
}

check();
