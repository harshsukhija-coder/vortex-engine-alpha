```
pnpm install
pnpm dev
```

```
open http://localhost:3001
```

## Vercel

Vercel picks up the default export from `src/index.ts`. Functions run in `bom1` (Mumbai), next to the Supabase `ap-south-1` pooler.

Set these in the Vercel project env (Production + Preview):

- `DATABASE_URL` — Supabase **transaction** pooler URL (port `6543`)
- `JWT_SECRET`
- `LOG_LEVEL` (optional, defaults to `info` on Vercel)

```
pnpm db:schema:push
pnpm db:seed
pnpm db:verify
```
