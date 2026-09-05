/** The timeline, read-only (§3.3 R5, ADR 0005). */
export { TimelineList } from './components/TimelineList';
export type { TimelineListProps } from './components/TimelineList';

/**
 * The clinical view (§10.7). Separate from the chronological one above because
 * §10.7 renders "clinically rather than chronologically-flat" — conditions as
 * intervals, labs as points — which is a different read model, not a filter.
 */
export { MedicalTimelineScreen } from './screens/MedicalTimelineScreen';
export { LifeTimelineScreen } from './screens/LifeTimelineScreen';
