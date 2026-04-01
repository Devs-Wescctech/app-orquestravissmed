const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const latestSuccess = await prisma.auditLog.findFirst({
    where: { action: 'REPLACE_SLOTS', details: { path: ['status'], equals: 'success' } },
    orderBy: { timestamp: 'desc' }
  });

  if (latestSuccess) {
      console.log('Success details:', JSON.stringify(latestSuccess.details));
  } else {
      // Try finding ANY replace slots to see what IDs it uses
      const any = await prisma.auditLog.findFirst({
          where: { action: 'REPLACE_SLOTS' },
          orderBy: { timestamp: 'desc' }
      });
      console.log('Last REPLACE_SLOTS log:', JSON.stringify(any));
  }
  
  await prisma.$disconnect();
}

check();
