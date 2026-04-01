const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const logs = await prisma.auditLog.findMany({
    orderBy: { timestamp: 'desc' },
    take: 20
  });

  console.log(JSON.stringify(logs, null, 2));
}

main().catch(e => console.error(e)).finally(() => prisma.$disconnect());
