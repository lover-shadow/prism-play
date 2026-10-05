/**
 * HP-01 ended/source identity.
 *
 * Three facts must all be true before `ended` can advance an episode: the current engine actually
 * received this episode as a media source (`loadedEpisodeId`), that same source reported real
 * playback (`startedEpisodeId`), and this source's end has not been spent yet (`endedEpisodeId`).
 * Each fact is stamped with the engine generation that established it, so an `ended` or `timeupdate`
 * that arrives late from a replaced source is refused instead of scanning the list.
 */
export interface EndedSourceState {
  loadedEpisodeId: number | null;
  startedEpisodeId: number | null;
  endedEpisodeId: number | null;
}

export const freshEndedSource = (): EndedSourceState => ({ loadedEpisodeId: null, startedEpisodeId: null, endedEpisodeId: null });

export function bindLoadedSource(episodeId: number): EndedSourceState {
  return { loadedEpisodeId: episodeId, startedEpisodeId: null, endedEpisodeId: null };
}

export function markPlaybackStarted(state: EndedSourceState, episodeId: number): EndedSourceState {
  return state.loadedEpisodeId === episodeId ? { ...state, startedEpisodeId: episodeId } : state;
}

export function canConsumeEnded(state: EndedSourceState, episodeId: number | null): boolean {
  if (episodeId === null) return false;
  return state.loadedEpisodeId === episodeId && state.startedEpisodeId === episodeId && state.endedEpisodeId !== episodeId;
}

/** Spends this episode's end, so a duplicate `ended` from the same source can never advance twice. */
export function consumeEnded(state: EndedSourceState, episodeId: number): EndedSourceState {
  return { ...state, endedEpisodeId: episodeId };
}

export interface EndedGuard {
  /** A new load invalidates every fact the previous source established. */
  beginLoad(): void;
  /** The engine is about to be handed this episode's media source. */
  bind(episodeId: number): void;
  confirmPlayback(episodeId: number | null): void;
  consumeEnded(episodeId: number | null): boolean;
  /** This episode's end was already spent by the live source. */
  endedFor(episodeId: number | null): boolean;
  /** The media reading belongs to this episode's loaded source. */
  ownsReading(episodeId: number | null): boolean;
  loadedEpisodeId(): number | null;
}

export function createEndedGuard(currentGeneration: () => number): EndedGuard {
  let state = freshEndedSource();
  let generation = currentGeneration();
  let bound = false;
  const live = (): boolean => bound && generation === currentGeneration();

  return {
    beginLoad: () => { state = freshEndedSource(); bound = false; generation = currentGeneration(); },
    bind: (episodeId) => { state = bindLoadedSource(episodeId); generation = currentGeneration(); bound = true; },
    confirmPlayback: (episodeId) => {
      if (episodeId === null || !live()) return;
      state = markPlaybackStarted(state, episodeId);
    },
    consumeEnded: (episodeId) => {
      if (!live() || !canConsumeEnded(state, episodeId)) return false;
      state = consumeEnded(state, episodeId as number);
      return true;
    },
    endedFor: (episodeId) => episodeId !== null && live() && state.endedEpisodeId === episodeId,
    ownsReading: (episodeId) => episodeId !== null && live() && state.loadedEpisodeId === episodeId,
    loadedEpisodeId: () => (live() ? state.loadedEpisodeId : null)
  };
}
