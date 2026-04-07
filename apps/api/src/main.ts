import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

process.on('uncaughtException', (err) => {
  if (err.message?.includes('ECONNREFUSED') && err.message?.includes('6379')) {
    return;
  }
  console.error('[VISMED-API] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason: any) => {
  if (reason?.message?.includes('ECONNREFUSED') && reason?.message?.includes('6379')) {
    return;
  }
  if (reason?.message?.includes('Connection is closed')) {
    return;
  }
  console.error('[VISMED-API] Unhandled Rejection:', reason);
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: '*', // For MVP, standard open CORS
  });

  const config = new DocumentBuilder()
    .setTitle('VisMed API')
    .setDescription('The VisMed API documentation for Dashboard and Mappings')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.VISMED_API_PORT || 3000;
  await app.listen(port);
  console.log(`[VISMED-API] Server is running on: http://localhost:${port}`);
  console.log(`[VISMED-API] Swagger Docs at: http://localhost:${port}/api/docs`);
}
bootstrap();
