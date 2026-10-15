```
## Local development

Requires Docker, Node.js, and pnpm.

```sh
pnpm install
pnpm setup:local
pnpm dev
```

The API runs at `http://localhost:3001`. PostgreSQL runs at
`localhost:5430` with database `vortex`. Local configuration lives in
`.env.development`.

Useful commands:

```sh
pnpm start:services
pnpm stop:services
pnpm db:migration:apply
pnpm db:seed
pnpm db:verify
```

## Visit rewards

Customers claim a visit; an admin approves it. Every **7 approved visits within
the last 30 days** unlock a single-use free-visit code (`VTX-XXXXXXXX`) that
expires **7 days** after it is generated. The 7 visits that unlocked a code are
marked `is_used` and never count towards another one. Rules live in
`src/core/visit-rewards.ts`.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/visit-rewards/visits` `{ phoneNumber, name }` | public | Claim today's visit (one per phone per IST day) |
| `GET /api/visit-rewards/status?phone=` | public | Reward state, progress and the customer's coupon codes (ACTIVE / REDEEMED / EXPIRED) |
| `GET /api/visit-rewards/visits?status=pending\|approved\|all&phone=` | admin | List visit claims |
| `POST /api/visit-rewards/visits/:id/approve` | admin | Approve; response includes `rewardCode` when one is unlocked |
| `DELETE /api/visit-rewards/visits/:id` | admin | Reject a pending claim |
| `GET /api/visit-rewards/codes?status=active\|redeemed\|expired\|all&phone=` | admin | List reward codes |
| `POST /api/visit-rewards/codes/redeem` `{ code, phoneNumber?, bookingId? }` | admin | Redeem a code (once, before expiry) |

### Using coupons on a booking (admin / super admin)

Pass `couponCodes` (an array) to `POST /api/bookings`, or to
`POST /api/offers/evaluate/actual` for a price preview. Each coupon makes one
player's share of the gameplay free (add-ons are never discounted), you can use
at most one coupon per player, and codes are redeemed atomically with the
booking. Tentative bookings do not accept coupons.

## Vercel

Vercel picks up the default export from `src/index.ts`. Functions run in `bom1` (Mumbai), next to the Supabase `ap-south-1` pooler.

Set these in the Vercel project env (Production + Preview):

- `DATABASE_URL` — Supabase **transaction** pooler URL (port `6543`)
- `JWT_SECRET`
- `LOG_LEVEL` (optional, defaults to `info` on Vercel)
