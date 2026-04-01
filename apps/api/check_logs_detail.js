const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const latestLogs = await prisma.auditLog.findMany({
    where: { action: 'REPLACE_SLOTS' },
    orderBy: { timestamp: 'desc' },
    take: 5
  });

  latestLogs.forEach(log => {
      console.log(`[${log.timestamp}] ${log.action} - ${log.details?.status || '??'}`);
      if (log.details) console.log(`  Details: ${JSON.stringify(log.details)}`);
      console.log('---');
  });
  
  await prisma.$disconnect();
}

check();
