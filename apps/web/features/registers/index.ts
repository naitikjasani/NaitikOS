/**
 * The register-authoring feature — §2.1's "no manual database intervention".
 *
 * Three editors that other features compose. They live in their own feature
 * rather than inside `skin` and `mind` because they share one endpoint, one
 * client, and one rule that neither owner would state the same way: **these
 * writes do not queue.** A schema change ordered behind the data it governs is
 * the one case where the outbox is the wrong tool.
 */
export { RoutineEditor } from './components/RoutineEditor';
export { MedicationRegisterForm } from './components/MedicationRegisterForm';
export { CrisisPlanScreen } from './screens/CrisisPlanScreen';
