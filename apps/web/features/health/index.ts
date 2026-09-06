/**
 * The Health feature — §7.2's public surface.
 *
 * The medication *register* is not here. §3.3(3) makes it "one row, three
 * lenses": Health owns the register, Mind presents the psychiatric subset, and
 * Skin reads treatment courses. The screens live where the lens lives, and
 * `/mind/meds` is the one that already exists.
 *
 * The medication *detail* is here, and the split is not an inconsistency. A
 * lens narrows a list; a detail page is one row in full, with a dose history
 * and the side effects suspected of it. There is no psychiatric version of that
 * page and there should not be — narrowing a single row is narrowing nothing.
 */

export { HealthOverviewScreen } from './screens/HealthOverviewScreen';
export { VitalsScreen } from './screens/VitalsScreen';
export { LabsScreen } from './screens/LabsScreen';
export { AnalyteScreen } from './screens/AnalyteScreen';
export { ConditionsScreen } from './screens/ConditionsScreen';
export { SymptomsScreen } from './screens/SymptomsScreen';
export { AppointmentsScreen } from './screens/AppointmentsScreen';
export { AppointmentPrepScreen } from './screens/AppointmentPrepScreen';
export { ConsultationPackScreen } from './screens/ConsultationPackScreen';
export { MedicationDetailScreen } from './screens/MedicationDetailScreen';
