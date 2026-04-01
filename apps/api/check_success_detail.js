const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const log = await prisma.auditLog.findFirst({
    where: { 
        action: 'REPLACE_SLOTS',
        details: { path: ['status'], equals: 'success' }
    },
    orderBy: { timestamp: 'desc' }
  });

  if (log) {
    console.log("SUCCESS REPLACE_SLOTS DETAILS:", JSON.stringify(log.details, null, 2));
  } else {
    console.log("No success log found");
  }
}

main().catch(e => console.error(e)).finally(() => prisma.$disconnect());
