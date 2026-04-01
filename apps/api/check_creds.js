const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const conn = await prisma.integrationConnection.findFirst({
      where: { provider: 'doctoralia' }
  });
  console.log(JSON.stringify(conn));
  await prisma.$disconnect();
}

check();
