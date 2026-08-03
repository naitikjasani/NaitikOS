# features/auth

Owns the browser-side authentication surface: the sign-in form, the session
context, and the typed client for `/api/auth/*`.

**Reads** nothing from other features. **Emits** a `ClientSession` through
`SessionProvider`, which the protected layout mounts and any client component
may read with `useSession()`.

**Deliberately does not** make authorization decisions. `useSession().can()` is
advisory and decides only what to render; every permission is re-checked
server-side by `authorize()` in `@naitikos/core` (§5.4). It also does not hold
tokens — those live in httpOnly cookies and never reach JavaScript.

**Boundary note.** The server half of auth is not here. It lives in
`lib/auth/` because middleware, layouts, and route handlers all need it and a
feature slice cannot be imported by `middleware.ts`.
