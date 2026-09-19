/**
 * The package barrel.
 *
 * `@pos/shared` is what both the Worker's tooling and the web app import, and
 * this is everything they may import. The subpath exports in `package.json`
 * (`./events`, `./money`, `./config`) exist for the places that want one module
 * without dragging the rest in; everywhere else takes the barrel.
 *
 * `config.js` comes first because `models.js` builds on it, which is also the
 * order a reader meets them in: what the app is configured with, then what it
 * stores, then what it broadcasts, then how it renders.
 */
export * from './config.js';
export * from './models.js';
export * from './events.js';
export * from './money.js';
export * from './totals.js';
export * from './timing.js';
export * from './ticket.js';
export * from './time.js';
export * from './i18n/index.js';
