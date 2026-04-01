require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { MatchingEngineService } = require('./dist/src/mappings/matching-engine.service');

async function runMatch() {
    console.log("Starting Matching Engine...");
    // Mock the Prisma service injected to the NestJS class
    const engine = new MatchingEngineService(prisma);

    // Polyfill the logger
    engine.logger = {
        log: console.log,
        debug: console.log,
        error: console.error,
        warn: console.warn
    };

    const count = await engine.runMatchingForUnmatched();
    console.log(`Matching process finished. Total new matches: ${count}`);

    const docCount = await prisma.doctoraliaDoctor.count();
    const mapCount = await prisma.professionalUnifiedMapping.count({ where: { isActive: true } });

    console.log(`\nFinal Stats:
    - Doctors: ${docCount}
    - Unified Mappings HQ (Doctors): ${mapCount}`);
}

runMatch().catch(console.error).finally(() => prisma.$disconnect());
