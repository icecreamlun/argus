/**
 * Truth people (M3): trapped persons on damaged buildings + evacuee crowds in open spaces, generated
 * deterministically from a QuakeResult and drawn as instanced low-poly humans. This is the hidden ground truth
 * the Argon reconstruction is scored against (never sent to the model).
 *
 * Usage (composition root):
 *   const people = createPeople(ctx); ctx.cityRoot.add(people.object);   // or scene.add
 *   on trigger:  people.build(result)          on reset: people.reset()
 *   per frame / seek: people.update(simSeconds)
 * For convenience the module also follows 'quake-tick' (emitted every frame while playing and on seek) once
 * built, and 'quake-reset', so it works even if the caller only calls build(). Waving / milling use wall-clock.
 */
import type { AppContext, PeopleHandle, PeopleTruth, QuakeResult } from '../../contracts';
import { generatePeople } from './generate';
import { PeopleMesh } from './render';

export { generatePeople } from './generate';
export { PERSON_SCALE } from './render';

export function createPeople(ctx: AppContext): PeopleHandle {
  const mesh = new PeopleMesh(4000);
  let truth: PeopleTruth | null = null;

  ctx.onUpdate((_dt, elapsed) => mesh.setWallTime(elapsed));
  ctx.events.on('quake-tick', ({ simSeconds }) => {
    if (truth) mesh.setSimTime(simSeconds);
  });
  ctx.events.on('quake-reset', () => handle.reset());

  const handle: PeopleHandle = {
    object: mesh.object,
    build(result: QuakeResult): PeopleTruth {
      truth = generatePeople(ctx.city, ctx.terrain, result);
      mesh.setPersons(truth.persons);
      mesh.setSimTime(0);
      return truth;
    },
    update(simSeconds: number) {
      if (truth) mesh.setSimTime(simSeconds);
    },
    reset() {
      truth = null;
      mesh.clear();
    },
    get truth() {
      return truth;
    },
  };
  return handle;
}
