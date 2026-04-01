import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

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
