import {migrateLegacyPreferences} from './local-origin.mjs';
await migrateLegacyPreferences();
await import('./app.mjs');
