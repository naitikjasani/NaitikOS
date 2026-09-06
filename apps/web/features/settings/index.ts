/**
 * The Settings feature — §3.2's configuration surface.
 *
 * Server-rendered. A settings page is opened deliberately and rarely, and
 * polling one would add exactly the background request §1.4's counter-metric
 * exists to discourage.
 */

export { AiSettingsScreen } from './screens/AiSettingsScreen';
export { AppearanceSettingsScreen } from './screens/AppearanceSettingsScreen';
export { CaptureSettingsScreen } from './screens/CaptureSettingsScreen';
export { NotificationsSettingsScreen } from './screens/NotificationsSettingsScreen';
export { IntegrationsSettingsScreen } from './screens/IntegrationsSettingsScreen';


/* The data surfaces (§3.2). The export builder is a client component only
 * because of one toggle; the audit viewer only because of one filter. */
export { ExportBuilderScreen } from './screens/ExportBuilderScreen';
export { AuditScreen } from './screens/AuditScreen';
