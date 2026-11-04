import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEventListener } from 'expo';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { router } from 'expo-router';
import { createContext, use, useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { MusicColors, MusicFonts } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { api, streamUrl, trackPath, type Track } from '@/lib/api';

const HISTORY_AFTER_SECONDS = 30;
const NOTICE_MS = 3000;

// The queue is not a secret, so it lives in AsyncStorage rather than SecureStore and its size limit
const QUEUE_KEY = 'player-queue';
const POSITION_KEY = 'player-position';
const SAVE_POSITION_EVERY_SECONDS = 5;

type SavedQueue = { queue: Track[]; index: number; loop: boolean };
type SavedPosition = { index: number; track: string; position: number };

const isTrack = (value: unknown): value is Track =>
  !!value &&
  typeof value === 'object' &&
  ((value as Track).source === 'AUDIUS' || (value as Track).source === 'LOCAL') &&
  typeof (value as Track).id === 'string' &&
  typeof (value as Track).title === 'string';

/** Reads the last session's queue, or null when there is none or it is unreadable. */
async function loadSavedSession() {
  const [[, rawQueue], [, rawPosition]] = await AsyncStorage.multiGet([QUEUE_KEY, POSITION_KEY]);
  if (!rawQueue) return null;
  const saved = JSON.parse(rawQueue) as Partial<SavedQueue>;
  const queue = Array.isArray(saved.queue) ? saved.queue.filter(isTrack) : [];
  const index = typeof saved.index === 'number' && saved.index >= 0 && saved.index < queue.length ? saved.index : 0;
  if (queue.length === 0) return null;

  const position = rawPosition ? (JSON.parse(rawPosition) as Partial<SavedPosition>) : null;
  // The position belongs to whatever played last, which may not be the saved current track
  const resumeAt =
    position?.index === index && position.track === trackPath(queue[index]) && typeof position.position === 'number'
      ? position.position
      : 0;
  return { queue, index, loop: saved.loop === true, resumeAt };
}

type Player = {
  track: Track | null;
  isPlaying: boolean;
  position: number;
  duration: number;
  loop: boolean;
  queue: Track[];
  index: number;
  /** Starts `track` with `queue` as the up-next list and opens the player. */
  open: (track: Track, queue?: Track[]) => void;
  playIndex: (index: number) => void;
  addToQueue: (track: Track, playNext?: boolean) => void;
  removeFromQueue: (index: number) => void;
  clearUpcomingQueue: () => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  seek: (seconds: number) => void;
  toggleLoop: () => void;
  stop: () => void;
  notify: (message: string) => void;
};

const PlayerContext = createContext<Player | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);

  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [loop, setLoop] = useState(false);
  const historySaved = useRef(false);
  const ended = useRef(false);
  // Set once the last session has been read, so an empty first render does not wipe it
  const [hydrated, setHydrated] = useState(false);
  // Cleared when the user starts something before the saved session finished loading
  const restorePending = useRef(true);
  // A restored track waits for the user to press play instead of blasting out at launch
  const autoplay = useRef(true);
  const resumeAt = useRef<number | null>(null);
  const savedPosition = useRef(0);

  const track = queue[index] ?? null;
  const source = track && streamUrl(track);
  const duration = status.duration || track?.duration || 0;

  const notify = (message: string) => setNotice(message);

  /** Any explicit play choice replaces the restored session. */
  const takeOver = () => {
    restorePending.current = false;
    autoplay.current = true;
    resumeAt.current = null;
  };

  const goTo = (target: number) => {
    takeOver();
    setIndex(target);
    // The same track queued twice keeps its URL, so the source effect below would never restart it
    if (queue[target] && source === streamUrl(queue[target])) {
      historySaved.current = false;
      ended.current = false;
      player.seekTo(0);
      player.play();
    }
  };

  // A finished track only counts as ended until it is played again, or its end is ignored next time
  const rearmEnd = () => {
    if (!ended.current) return;
    ended.current = false;
    historySaved.current = false;
  };

  const next = () => {
    if (queue.length > 1) goTo((index + 1) % queue.length);
    else player.seekTo(0);
  };

  const playIndex = (targetIndex: number) => {
    if (targetIndex >= 0 && targetIndex < queue.length) {
      goTo(targetIndex);
    }
  };

  const addToQueue = (newTrack: Track, playNext = false) => {
    if (newTrack.isAvailable === false) return;
    if (queue.length === 0) {
      takeOver();
      setQueue([newTrack]);
      setIndex(0);
      notify(`Đang phát: ${newTrack.title}`);
      return;
    }
    if (playNext) {
      const nextQueue = [...queue];
      nextQueue.splice(index + 1, 0, newTrack);
      setQueue(nextQueue);
      notify(`Sẽ phát tiếp theo: ${newTrack.title}`);
    } else {
      setQueue((prev) => [...prev, newTrack]);
      notify(`Đã thêm vào hàng đợi: ${newTrack.title}`);
    }
  };

  const removeFromQueue = (removeIndex: number) => {
    if (removeIndex < 0 || removeIndex >= queue.length) return;
    if (removeIndex === index) {
      if (queue.length > 1) {
        const nextQueue = queue.filter((_, i) => i !== removeIndex);
        setQueue(nextQueue);
        if (removeIndex >= nextQueue.length) setIndex(0);
      } else {
        player.pause();
        player.clearLockScreenControls?.();
        setQueue([]);
        setIndex(0);
      }
    } else {
      setQueue((prev) => prev.filter((_, i) => i !== removeIndex));
      if (removeIndex < index) setIndex((prev) => prev - 1);
    }
  };

  const clearUpcomingQueue = () => {
    if (queue.length <= 1) return;
    setQueue((prev) => prev.slice(0, index + 1));
    notify('Đã dọn danh sách chờ tiếp theo');
  };

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' });
  }, []);

  useEffect(() => {
    let active = true;
    loadSavedSession()
      .then((saved) => {
        if (!active || !saved || !restorePending.current) return;
        autoplay.current = false;
        resumeAt.current = saved.resumeAt > 0 ? saved.resumeAt : null;
        savedPosition.current = saved.resumeAt;
        setQueue(saved.queue);
        setIndex(saved.index);
        setLoop(saved.loop);
      })
      // A corrupt or unreadable save only costs the resume, never the launch
      .catch(console.warn)
      .finally(() => {
        restorePending.current = false;
        if (active) setHydrated(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const write =
      queue.length === 0
        ? AsyncStorage.multiRemove([QUEUE_KEY, POSITION_KEY])
        : AsyncStorage.setItem(QUEUE_KEY, JSON.stringify({ queue, index, loop } satisfies SavedQueue));
    write.catch(console.warn);
  }, [hydrated, queue, index, loop]);

  const savePosition = (position: number) => {
    if (!track) return;
    savedPosition.current = position;
    const saved: SavedPosition = { index, track: trackPath(track), position };
    AsyncStorage.setItem(POSITION_KEY, JSON.stringify(saved)).catch(console.warn);
  };

  useEffect(() => {
    if (!source) return;
    historySaved.current = false;
    ended.current = false;
    player.replace({ uri: source });
    if (autoplay.current) player.play();
  }, [player, source]);

  const title = track?.title;
  const artist = track?.artist;
  const artwork = track?.artwork;
  useEffect(() => {
    if (!title) return;
    // Android stops background audio after about 3 minutes without lock screen controls
    player.setActiveForLockScreen?.(true, { title, artist, artworkUrl: artwork ?? undefined });
  }, [player, title, artist, artwork]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  useEventListener(player, 'playbackStatusUpdate', (update) => {
    // The saved position can only be applied once the restored source has loaded
    if (resumeAt.current !== null) {
      if (update.isLoaded) {
        player.seekTo(resumeAt.current);
        resumeAt.current = null;
        return;
      }
      // A source that fails never loads, so give up on the seek and let the error through
      if (!update.error) return;
      resumeAt.current = null;
    }

    // Listening 30 seconds counts as a play, or finishing a shorter track; a paused resume does not
    const listened = update.playing && update.currentTime >= HISTORY_AFTER_SECONDS;
    if (track && user && !historySaved.current && (listened || update.didJustFinish)) {
      historySaved.current = true;
      api('/api/me/history', { method: 'POST', body: { source: track.source, id: track.id } }).catch(console.warn);
    }

    // Save every few seconds while playing, and right away on pause
    const moved = Math.abs(update.currentTime - savedPosition.current);
    if (update.isLoaded && (moved >= SAVE_POSITION_EVERY_SECONDS || (!update.playing && moved > 0))) {
      savePosition(update.currentTime);
    }

    if (ended.current || !(update.didJustFinish || update.error)) return;
    if (update.error && !autoplay.current) {
      // A restored track that no longer streams waits for the user instead of skipping on its own
      ended.current = true;
      notify('Không phát được bài đã nghe lần trước');
      return;
    }
    if (update.error) notify('Không phát được bài này');
    else if (loop) {
      player.seekTo(0);
      player.play();
      return;
    }

    ended.current = true;
    // No wrap-around here: a queue of broken tracks must not retry forever
    if (index < queue.length - 1) goTo(index + 1);
    else player.seekTo(0);
  });

  return (
    <PlayerContext
      value={{
        track,
        isPlaying: status.playing,
        position: status.currentTime,
        duration,
        loop,
        queue,
        index,
        open: (song, list = [song]) => {
          const playable = list.filter((item) => item.isAvailable !== false);
          takeOver();
          setQueue(playable);
          setIndex(Math.max(playable.findIndex((item) => item.source === song.source && item.id === song.id), 0));
          router.push('/player');
        },
        playIndex,
        addToQueue,
        removeFromQueue,
        clearUpcomingQueue,
        toggle: () => {
          if (status.playing) return player.pause();
          // The restored track failed to load, so play moves on as it would have mid-queue
          if (ended.current && !autoplay.current) return next();
          autoplay.current = true;
          rearmEnd();
          player.play();
        },
        next,
        previous: () => {
          // Like most players: restart the track unless it has only just begun
          if (status.currentTime > 3 || queue.length < 2) player.seekTo(0);
          else goTo((index - 1 + queue.length) % queue.length);
        },
        seek: (seconds) => {
          // Before the restored source loads, a seek would be overwritten by the saved position
          if (resumeAt.current !== null) resumeAt.current = seconds;
          rearmEnd();
          player.seekTo(seconds);
        },
        toggleLoop: () => setLoop(!loop),
        stop: () => {
          player.pause();
          player.clearLockScreenControls?.();
          setQueue([]);
          setIndex(0);
        },
        notify,
      }}>
      {children}
      {notice && (
        <View pointerEvents="none" style={styles.notice}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      )}
    </PlayerContext>
  );
}

export function usePlayer() {
  const player = use(PlayerContext);
  if (!player) throw new Error('usePlayer must be used inside PlayerProvider');
  return player;
}

/** Space a scrolling tab screen must leave for the nav bar or mini-player. */
export function useTabBarSpace() {
  return usePlayer().track ? 260 : 120;
}

const styles = StyleSheet.create({
  notice: {
    position: 'absolute',
    top: 56,
    alignSelf: 'center',
    maxWidth: '90%',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: MusicColors.brown,
  },
  noticeText: {
    fontFamily: MusicFonts.semiBold,
    fontSize: 14,
    color: MusicColors.cream,
  },
});
