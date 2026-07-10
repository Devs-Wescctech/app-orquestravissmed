# Documentação Técnica — Integração Orquestrador ↔ Doctoralia/Docplanner

> Versão 1.0 · API alvo: **Docplanner API v3 (camada Integration)** · Base: `/api/v3/integration/...`

## 1. Visão geral

O orquestrador é uma plataforma-ponte que sincroniza de forma **bidirecional** cadastros, agenda e agendamentos entre o sistema de origem da clínica e a Doctoralia.

- **Pull (Doctoralia → Orquestrador):** facilities, médicos, endereços, serviços, convênios.
- **Push (Orquestrador → Doctoralia):** slots (disponibilidade), breaks (bloqueios), serviços, convênios e agendamentos.
- **Tempo real:** webhooks da Doctoralia + polling de notificações como *fallback*.

## 2. Autenticação (OAuth2 Client Credentials)

**Requisição:**
```http
POST https://www.doctoralia.com.br/oauth/v2/token
Authorization: Basic {base64(clientId:clientSecret)}
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&scope=integration
```

**Resposta:**
```json
{
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9...",
  "token_type": "bearer",
  "expires_in": 3600,
  "scope": "integration"
}
```
O `access_token` é reenviado em todas as chamadas como `Authorization: Bearer {token}`.

## 3. Hierarquia de recursos
```
facility (facilityId)
 └─ doctor (doctorId)
     └─ address (addressId)
         ├─ services
         ├─ insurance-providers
         ├─ slots
         ├─ breaks
         └─ bookings
```

## 4. Endpoints consumidos

### 4.1 Cadastros (GET)
| Método | Rota |
|--------|------|
| GET | `/facilities` |
| GET | `/facilities/{facilityId}/doctors` |
| GET | `/facilities/{facilityId}/doctors/{doctorId}/addresses` |
| GET | `.../addresses/{addressId}/services` |
| GET | `/facilities/{facilityId}/services` |
| GET | `/facilities/{facilityId}/services/catalog` |
| GET | `/services` (dicionário global) |
| GET | `.../addresses/{addressId}/calendar` |

### 4.2 Convênios
| Método | Rota |
|--------|------|
| GET | `/insurance-providers` |
| GET | `/insurance-providers/{providerId}/plans` |
| GET | `.../addresses/{addressId}/insurance-providers` |
| POST | `.../addresses/{addressId}/insurance-providers` |
| PUT | `.../addresses/{addressId}/insurance-providers` |
| DELETE | `.../addresses/{addressId}/insurance-providers/{providerId}` |

### 4.3 Serviços (escrita)
| Método | Rota |
|--------|------|
| POST | `.../addresses/{addressId}/services` |
| PATCH | `.../addresses/{addressId}/services/{serviceId}` |
| DELETE | `.../addresses/{addressId}/services/{serviceId}` |

### 4.4 Endereço
| Método | Rota |
|--------|------|
| PATCH | `.../addresses/{addressId}` |

### 4.5 Agenda / Slots
| Método | Rota |
|--------|------|
| GET | `.../addresses/{addressId}/slots?start={ISO}&end={ISO}` |
| PUT | `.../addresses/{addressId}/slots` (**replaceSlots**) |
| DELETE | `.../addresses/{addressId}/slots/{YYYY-MM-DD}` |
| POST | `.../addresses/{addressId}/calendar/enable` |
| POST | `.../addresses/{addressId}/calendar/disable` |

### 4.6 Bloqueios (Breaks)
| Método | Rota |
|--------|------|
| GET | `.../addresses/{addressId}/breaks?since={ISO}&till={ISO}` |
| GET | `.../addresses/{addressId}/breaks/{breakId}` |
| POST | `.../addresses/{addressId}/breaks` |
| PATCH | `.../addresses/{addressId}/breaks/{breakId}` |
| DELETE | `.../addresses/{addressId}/breaks/{breakId}` |

### 4.7 Agendamentos (Bookings)
| Método | Rota |
|--------|------|
| GET | `.../addresses/{addressId}/bookings?start={ISO}&end={ISO}` |
| POST | `.../addresses/{addressId}/slots/{slotStart}/book` |
| POST | `.../addresses/{addressId}/bookings/{bookingId}/move` |
| DELETE | `.../addresses/{addressId}/bookings/{bookingId}` |

### 4.8 Notificações (fallback)
| Método | Rota |
|--------|------|
| GET | `/notifications/multiple?limit={n}` |
| POST | `/notifications/release` |

## 5. Exemplos de payload (requisições enviadas)

### 5.1 `PUT slots` — replaceSlots
Substitui **todo** o calendário do endereço para o período enviado.
```json
{
  "slots": [
    {
      "start": "2026-07-15T09:00:00-03:00",
      "end": "2026-07-15T09:30:00-03:00",
      "address_services": [
        { "address_service_id": "123456", "duration": 30 }
      ],
      "insurance_accepted": "with-insurance-only",
      "insurance_providers": [2717],
      "insurance_plans": [88012]
    },
    {
      "start": "2026-07-15T09:30:00-03:00",
      "end": "2026-07-15T10:00:00-03:00",
      "address_services": [
        { "address_service_id": "123456", "duration": 30 }
      ],
      "insurance_accepted": "with-insurance-only",
      "insurance_providers": [2717],
      "insurance_plans": [88012]
    }
  ]
}
```
> `insurance_accepted` aceita: `with-insurance-only`, `without-insurance-only`, `with-and-without-insurance`.
> Quando há convênio, `insurance_plans` é **obrigatório** para a página pública exibir o convênio corretamente.

### 5.2 `POST .../slots/{slotStart}/book` — criar agendamento
```json
{
  "address_service_id": 123456,
  "duration": 30,
  "is_returning": false,
  "patient": {
    "name": "Maria",
    "surname": "Silva",
    "email": "maria.silva@exemplo.com",
    "phone": 5551999998888,
    "birth_date": "1990-05-20",
    "nin": "12345678900",
    "gender": "f"
  }
}
```
> `gender`: `"f"` ou `"m"`. `nin` = CPF. `phone` enviado como número (apenas dígitos).
> Resposta contém `{ "id": "<doctoraliaBookingId>", ... }`.

### 5.3 `POST .../bookings/{bookingId}/move` — reagendar
```json
{
  "address_service_id": 123456,
  "duration": 30,
  "start": "2026-07-16T14:00:00-03:00",
  "address_id": 7890
}
```

### 5.4 `DELETE .../bookings/{bookingId}` — cancelar
```json
{ "reason": "Cancelado na origem (VisMed)" }
```

### 5.5 `POST .../insurance-providers` — vincular convênio
```json
{
  "insurance_provider_id": "2717",
  "insurance_plans": [
    { "insurance_plan_id": "88012" }
  ]
}
```

### 5.6 `POST .../breaks` — criar bloqueio
```json
{
  "since": "2026-07-15T12:00:00-03:00",
  "till": "2026-07-15T13:00:00-03:00"
}
```

## 6. Webhooks recebidos da Doctoralia

**Endpoint exposto pelo orquestrador:** `POST /webhooks/doctoralia`
O evento é identificado pelo campo `name`. O corpo segue o envelope `{ name, data }`.

### 6.1 `slot-booked` (paciente marcou na Doctoralia)
```json
{
  "name": "slot-booked",
  "data": {
    "visit_booking": {
      "id": "987654",
      "start": "2026-07-15T09:00:00-03:00",
      "duration": 30,
      "address_service_id": 123456,
      "patient": {
        "name": "João",
        "surname": "Souza",
        "phone": "5551988887777",
        "email": "joao.souza@exemplo.com",
        "nin": "98765432100"
      }
    }
  }
}
```

### 6.2 `booking-canceled` (cancelamento na Doctoralia)
```json
{
  "name": "booking-canceled",
  "data": {
    "visit_booking": {
      "id": "987654",
      "start": "2026-07-15T09:00:00-03:00",
      "patient": { "name": "João", "surname": "Souza" }
    }
  }
}
```

### 6.3 `booking-moved` (reagendamento na Doctoralia)
Usa `new_visit_booking` (depois) e `old_visit_booking` (antes). No reschedule, a Doctoralia pode gerar um **novo `id`**.
```json
{
  "name": "booking-moved",
  "data": {
    "old_visit_booking": {
      "id": "987654",
      "start": "2026-07-15T09:00:00-03:00"
    },
    "new_visit_booking": {
      "id": "987999",
      "start": "2026-07-16T14:00:00-03:00",
      "duration": 30,
      "address_service_id": 123456,
      "patient": { "name": "João", "surname": "Souza", "phone": "5551988887777" }
    }
  }
}
```

### 6.4 Contrato de resposta do webhook
| Situação | HTTP | Corpo |
|----------|------|-------|
| Processado com sucesso | `200 OK` | `{ "ok": true, ... }` |
| Falha ao espelhar na origem | `500` | `{ "ok": false, "reason": "..." }` (sinaliza reentrega) |

## 7. Polling de fallback

Além dos webhooks, o orquestrador consulta `GET /notifications/multiple` a cada ~30s e reconcilia o estado a cada ciclo. Notificações que falharam podem ser reprocessadas via `POST /notifications/release`. O `id` do booking nas notificações fica em `data.visit_booking.id`.

## 8. Tratamento de erros e status HTTP

| Status | Significado no orquestrador |
|--------|-----------------------------|
| `200` | Sucesso com corpo JSON |
| `201` | Criação — lê o header `Location` do recurso criado |
| `204` | Sucesso sem corpo |
| `>= 400` | Erro — captura `status` + corpo (`details`), loga e reenfileira |

Cada chamada tem **timeout** (via `AbortController`) para evitar travamentos.

## 9. Escalabilidade e robustez

- **Fila de jobs** em PostgreSQL (`FOR UPDATE SKIP LOCKED`), com *backoff* exponencial e *dead-letter* após múltiplas tentativas.
- **Rate limiter** *token-bucket* por provider, respeitando limites da API.
- **Deduplicação** por `dedupKey` (ex.: `clinicId:evento:bookingId`) e proteção anti-loop/anti-eco.
- **Isolamento multi-tenant:** webhooks exigem correspondência exata de `facilityId` (sem *fallback* entre clínicas).

## 10. Convenções de data/hora

Todas as datas usam **ISO-8601 com timezone** (ex.: `2026-07-15T09:00:00-03:00`). O fuso padrão das clínicas é `America/Sao_Paulo`.
