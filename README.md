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

## Vercel

Vercel picks up the default export from `src/index.ts`. Functions run in `bom1` (Mumbai), next to the Supabase `ap-south-1` pooler.

Set these in the Vercel project env (Production + Preview):

- `DATABASE_URL` — Supabase **transaction** pooler URL (port `6543`)
- `JWT_SECRET`
- `LOG_LEVEL` (optional, defaults to `info` on Vercel)
