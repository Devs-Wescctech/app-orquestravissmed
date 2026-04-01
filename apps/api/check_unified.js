const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const unified = await prisma.professionalUnifiedMapping.findMany({
    include: {
      vismedDoctor: true,
      doctoraliaDoctor: true
    }
  });
  
  console.log(`ProfessionalUnifiedMapping count: ${unified.length}`);
  unified.forEach(m => {
    console.log(`Matched: Vismed(${m.vismedDoctor.name}) <-> Doctoralia(${m.doctoraliaDoctor.name}) [Active: ${m.isActive}]`);
  });
}

main().finally(() => prisma.$disconnect());
