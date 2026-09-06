/**
 * People and Places — §7.2's public surface.
 *
 * Both screens are server-rendered from `lib/platform/social.ts` and take their
 * board as a prop. Neither polls: a relationship log and a travel record are
 * opened deliberately, and there is no live state in either worth watching.
 */

export { PeopleScreen } from './screens/PeopleScreen';
export { PlacesScreen } from './screens/PlacesScreen';
