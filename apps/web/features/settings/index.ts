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

/* §3.2 gives `/settings/privacy` "encryption, media keys, redaction" — the
 * boundaries of what this machine holds and what leaves it. This is the one of
 * those boundaries a control can genuinely move, so it is the page's only
 * button. A client component of necessity: all three stores it reports on are
 * browser-only, and none of them exists on the server. */
export { LocalDataScreen } from './screens/LocalDataScreen';

/* §3.2's `/settings/developer` — flags, diagnostics, schema version, and §5.2's
 * manual trigger. Server-rendered like the rest; the trigger button is a client
 * island inside it, and it is not exported because nothing else may start a job
 * run out of context. */
export { DiagnosticsScreen } from './screens/DiagnosticsScreen';
