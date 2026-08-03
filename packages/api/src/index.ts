/**
 * @naitikos/api — contracts and transport.
 *
 * §5.0 places this layer above `db` and below the app, and §5.2 sets its one
 * rule: "route handlers are transport, not logic. A handler parses,
 * authenticates, delegates to a domain service, and serialises. Zero business
 * rules."
 *
 * Everything here serves that: schemas to parse with, guards to authenticate
 * with, an error map to serialise with. The decisions all live in `core`.
 */
export * from './contracts';
export * from './errors';
export * from './middleware';
export * from './guards';
