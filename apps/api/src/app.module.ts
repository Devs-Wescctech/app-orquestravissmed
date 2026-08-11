import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ClinicsModule } from './clinics/clinics.module';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { IntegrationsModule } from './integrations/integrations.module';
import { SyncModule } from './sync/sync.module';
import { MappingsModule } from './mappings/mappings.module';
import { DoctorsModule } from './doctors/doctors.module';
import { AppointmentsModule } from './appointments/appointments.module';
import { BookingsModule } from './bookings/bookings.module';
import { SettingsModule } from './settings/settings.module';
import { MetricsModule } from './metrics/metrics.module';
import { APP_FILTER } from '@nestjs/core';
import { DoctoraliaCircuitOpenFilter } from './integrations/doctoralia-circuit-open.filter';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    UsersModule,
    ClinicsModule,
    DoctorsModule,
    AppointmentsModule,
    BookingsModule,
    IntegrationsModule,
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null,
        retryStrategy: () => null,
        reconnectOnError: () => false,
        enableOfflineQueue: false,
        lazyConnect: true,
        enableReadyCheck: false,
      },
    }),
    SyncModule,
    MappingsModule,
    SettingsModule,
    MetricsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // WP-08A: fast-fail do circuito Doctoralia vira 503 amigável na UI.
    { provide: APP_FILTER, useClass: DoctoraliaCircuitOpenFilter },
  ],
})
export class AppModule { }
