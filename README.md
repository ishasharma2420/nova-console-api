# Nova Console API

Backend service for Nova Console — No-show prediction & smart reschedule for Vanderlyn Medical Center.

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/nova/dashboard` | Summary stats for Console UI |
| GET | `/nova/patients` | At-risk patient queue |
| POST | `/nova/predict` | Run risk scoring on all upcoming appointments |
| POST | `/nova/slots/recommend` | Get ranked slot recommendations for a patient |
| POST | `/nova/backfill` | Match freed slot to best waitlist candidate |
| GET | `/nova/interventions` | Intervention log |

## Setup

1. Clone repo
2. Run `npm install`
3. Copy `.env.example` to `.env` and fill in your credentials
4. Run `npm start`

## Environment Variables

See `.env.example` for all required variables.

## Render Deployment

- Build command: `npm install`
- Start command: `node index.js`
- Add all env vars from `.env.example` in Render dashboard

## Query Parameters — /nova/patients

| Param | Description |
|-------|-------------|
| `band` | Filter by risk band: High / Medium / Low |
| `clinic` | Filter by clinic location |
| `service` | Filter by service line |
| `limit` | Max results (default 100) |

## POST Body — /nova/predict

```json
{ "useAI": true }
```
Set `useAI: true` to generate OpenAI narratives for High risk patients (slower, more impressive for demo).

## POST Body — /nova/slots/recommend

```json
{
  "patient_id": "prospect-id-here",
  "service_line": "Mental Health",
  "current_slot_datetime": "2026-03-15 18:00:00"
}
```

## POST Body — /nova/backfill

```json
{
  "appointment_id": "APT-XXXXXXXX",
  "freed_slot_id": "SLT-XXXXXXXX",
  "service_line": "Mental Health"
}
```
