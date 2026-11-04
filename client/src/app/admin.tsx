import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LoadState } from '@/components/load-state';
import { gradient, MusicColors, MusicFonts } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useFetch } from '@/hooks/use-fetch';
import { usePlayer } from '@/hooks/use-player';
import { api, type AdminStats, type AdminTrack, type AdminUser, type Page } from '@/lib/api';
import { goBack } from '@/lib/go-back';
import { formatDuration } from '@/lib/upload-helper';

const TABS = ['Thống kê', 'Người dùng', 'Bài hát'] as const;
type Tab = (typeof TABS)[number];

const PAGE_SIZE = 20;
const ROLE_LABELS = { LISTENER: 'Người nghe', ARTIST: 'Nghệ sĩ', ADMIN: 'Admin' } as const;
const BACKGROUND = gradient('linear-gradient(211.1deg, rgb(227, 78, 31) 4.81%, rgb(107, 56, 48) 92.97%)');

export default function AdminScreen() {
  const { user, ready } = useAuth();
  const insets = useSafeAreaInsets();
  const paddingTop = Math.max(insets.top, 42) + 16;
  const paddingBottom = Math.max(insets.bottom, 24) + 20;
  const [tab, setTab] = useState<Tab>('Thống kê');

  const isAdmin = user?.role === 'ADMIN';

  return (
    <View style={[styles.screen, BACKGROUND]}>
      <View style={[styles.header, { paddingTop }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Quay lại" onPress={goBack} style={styles.back}>
          <Image source={require('@/assets/images/music/dropdown.svg')} contentFit="fill" style={styles.backIcon} />
        </Pressable>
        <Text accessibilityRole="header" style={styles.headerTitle}>
          Quản trị
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      {!ready ? null : !isAdmin ? (
        <View style={styles.denied}>
          <Text style={styles.deniedText}>Chỉ tài khoản Admin mới dùng được chức năng này.</Text>
          {!user && (
            <Pressable accessibilityRole="button" onPress={() => router.push('/account')} style={styles.primaryButton}>
              <Text style={styles.primaryButtonLabel}>Đăng nhập</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom }]}
          showsVerticalScrollIndicator={false}>
          <View accessibilityRole="tablist" style={styles.tabs}>
            {TABS.map((name) => (
              <Pressable
                key={name}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === name }}
                onPress={() => setTab(name)}
                style={[styles.tab, tab === name && styles.tabSelected]}>
                <Text style={styles.tabLabel}>{name}</Text>
              </Pressable>
            ))}
          </View>

          {tab === 'Thống kê' ? <StatsTab /> : tab === 'Người dùng' ? <UsersTab /> : <TracksTab />}
        </ScrollView>
      )}
    </View>
  );
}

/** Reloads whenever the screen regains focus, since other screens can change the same data. */
function useFocusedFetch<T>(path: string) {
  const result = useFetch<T>(path);
  const reload = result.reload;
  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );
  return result;
}

function StatsTab() {
  const stats = useFocusedFetch<AdminStats>('/api/admin/stats');
  const data = stats.data;

  return (
    <>
      <LoadState loading={stats.loading && !data} error={stats.error} onRetry={stats.reload} />
      {data && (
        <>
          <Text style={styles.sectionTitle}>Người dùng</Text>
          <View style={styles.statGrid}>
            <StatCard label="Người nghe" value={data.users.LISTENER} />
            <StatCard label="Nghệ sĩ" value={data.users.ARTIST} />
            <StatCard label="Admin" value={data.users.ADMIN} />
          </View>

          <Text style={styles.sectionTitle}>Bài hát tải lên</Text>
          <View style={styles.statGrid}>
            <StatCard label="Tổng số bài" value={data.tracks} />
            <StatCard label="Công khai" value={data.tracks - data.hiddenTracks} color={GOOD} />
            <StatCard label="Bị ẩn" value={data.hiddenTracks} color={data.hiddenTracks > 0 ? BAD : undefined} />
          </View>

          <Text style={styles.note}>
            Không có số lượt nghe, vì nhạc Audius phát thẳng từ Audius chứ không đi qua máy chủ.
          </Text>
        </>
      )}
    </>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <View style={styles.statCard}>
      <Text style={[styles.statValue, color ? { color } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function UsersTab() {
  const { notify } = usePlayer();
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const users = useFocusedFetch<Page<AdminUser>>(`/api/admin/users?page=${page}&limit=${PAGE_SIZE}`);

  const goToPage = (next: number) => {
    setConfirmingId(null);
    setPage(next);
  };

  const setActive = async (target: AdminUser, isActive: boolean) => {
    // Locking signs the person out at once, so it takes a second tap; unlocking does not
    if (!isActive && confirmingId !== target.id) return setConfirmingId(target.id);
    setConfirmingId(null);
    setBusyId(target.id);
    try {
      await api(`/api/admin/users/${target.id}`, { method: 'PATCH', body: { isActive } });
      notify(isActive ? `Đã mở khoá ${target.name}` : `Đã khoá ${target.name}`);
      users.reload();
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <LoadState loading={users.loading && !users.data} error={users.error} onRetry={users.reload} />
      {users.data?.items.length === 0 && <Text style={styles.empty}>Chưa có người dùng</Text>}
      {users.data?.items.map((item) => (
        <View key={item.id} style={[styles.card, !item.isActive && styles.cardFlagged]}>
          <View style={styles.cardBody}>
            <Text numberOfLines={1} style={styles.cardTitle}>
              {item.name}
            </Text>
            <Text numberOfLines={1} style={styles.cardSub}>
              {item.email}
            </Text>
            <View style={styles.metaRow}>
              <Text style={styles.tag}>{ROLE_LABELS[item.role]}</Text>
              {!item.isActive && <Text style={styles.flag}>Đã khoá</Text>}
            </View>
          </View>
          {item.role !== 'ADMIN' && (
            <ActionButton
              label={item.isActive ? (confirmingId === item.id ? 'Xác nhận khoá' : 'Khoá') : 'Mở khoá'}
              accessibilityLabel={`${item.isActive ? 'Khoá' : 'Mở khoá'} tài khoản ${item.name}`}
              danger={item.isActive}
              busy={busyId === item.id}
              onPress={() => setActive(item, !item.isActive)}
            />
          )}
        </View>
      ))}
      <Pager page={page} total={users.data?.total} onChange={goToPage} />
    </>
  );
}

function TracksTab() {
  const { open, notify } = usePlayer();
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const tracks = useFocusedFetch<Page<AdminTrack>>(`/api/admin/tracks?page=${page}&limit=${PAGE_SIZE}`);
  const items = tracks.data?.items ?? [];
  const playable = items.filter((item) => !item.isHidden);

  const goToPage = (next: number) => {
    setConfirmingId(null);
    setPage(next);
  };

  const setHidden = async (target: AdminTrack, isHidden: boolean) => {
    // Hiding pulls the song from everyone at once, so it takes a second tap; showing it again does not
    if (isHidden && confirmingId !== target.id) return setConfirmingId(target.id);
    setConfirmingId(null);
    setBusyId(target.id);
    try {
      await api(`/api/admin/tracks/${target.id}`, { method: 'PATCH', body: { isHidden } });
      notify(isHidden ? `Đã ẩn bài ${target.title}` : `Đã hiện lại bài ${target.title}`);
      tracks.reload();
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <LoadState loading={tracks.loading && !tracks.data} error={tracks.error} onRetry={tracks.reload} />
      {tracks.data && items.length === 0 && <Text style={styles.empty}>Chưa có bài hát nào được tải lên</Text>}
      {items.map((item) => (
        <View key={item.id} style={[styles.card, item.isHidden && styles.cardFlagged]}>
          {/* A hidden song no longer streams, so only visible ones can be previewed */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={item.isHidden ? `${item.title}, đang ẩn` : `Nghe thử ${item.title}`}
            disabled={item.isHidden}
            onPress={() => open(item, playable)}
            style={styles.artworkBox}>
            {item.artwork ? (
              <Image source={item.artwork} style={styles.artwork} />
            ) : (
              <Text style={styles.artworkFallback}>🎶</Text>
            )}
          </Pressable>
          <View style={styles.cardBody}>
            <Text numberOfLines={1} style={styles.cardTitle}>
              {item.title}
            </Text>
            <Text numberOfLines={1} style={styles.cardSub}>
              {item.artist}
            </Text>
            <View style={styles.metaRow}>
              {item.genre ? <Text style={styles.tag}>{item.genre}</Text> : null}
              <Text style={styles.cardSub}>{formatDuration(item.duration)}</Text>
              {item.isHidden && <Text style={styles.flag}>Đang ẩn</Text>}
            </View>
          </View>
          <ActionButton
            label={item.isHidden ? 'Hiện' : confirmingId === item.id ? 'Xác nhận ẩn' : 'Ẩn'}
            accessibilityLabel={`${item.isHidden ? 'Hiện lại' : 'Ẩn'} bài ${item.title}`}
            danger={!item.isHidden}
            busy={busyId === item.id}
            onPress={() => setHidden(item, !item.isHidden)}
          />
        </View>
      ))}
      <Pager page={page} total={tracks.data?.total} onChange={goToPage} />
    </>
  );
}

type ActionButtonProps = {
  label: string;
  accessibilityLabel: string;
  danger: boolean;
  busy: boolean;
  onPress: () => void;
};

function ActionButton({ label, accessibilityLabel, danger, busy, onPress }: ActionButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={onPress}
      style={[styles.action, danger ? styles.actionDanger : styles.actionSafe]}>
      {busy ? (
        <ActivityIndicator size="small" color={MusicColors.cream} />
      ) : (
        <Text style={[styles.actionLabel, { color: danger ? BAD : GOOD }]}>{label}</Text>
      )}
    </Pressable>
  );
}

function Pager({ page, total, onChange }: { page: number; total?: number; onChange: (page: number) => void }) {
  if (!total) return null;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages === 1) return <Text style={styles.pagerInfo}>{total} mục</Text>;

  return (
    <View style={styles.pager}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Trang trước"
        accessibilityState={{ disabled: page <= 1 }}
        disabled={page <= 1}
        onPress={() => onChange(page - 1)}
        style={[styles.pagerButton, page <= 1 && styles.pagerDisabled]}>
        <Text style={styles.pagerLabel}>‹ Trước</Text>
      </Pressable>
      <Text style={styles.pagerInfo}>
        Trang {page}/{pages} · {total} mục
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Trang sau"
        accessibilityState={{ disabled: page >= pages }}
        disabled={page >= pages}
        onPress={() => onChange(page + 1)}
        style={[styles.pagerButton, page >= pages && styles.pagerDisabled]}>
        <Text style={styles.pagerLabel}>Sau ›</Text>
      </Pressable>
    </View>
  );
}

const GOOD = '#88D49E';
const BAD = '#FF8A8A';

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  back: {
    padding: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  backIcon: {
    width: 20,
    height: 20,
    transform: [{ rotate: '90deg' }],
  },
  headerTitle: {
    fontFamily: MusicFonts.bold,
    fontSize: 20,
    color: MusicColors.cream,
  },
  headerSpacer: {
    width: 36,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  tabs: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 20,
  },
  tab: {
    flex: 1,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#ffffff',
    borderRadius: 40,
  },
  tabSelected: {
    backgroundColor: 'rgba(115, 65, 57, 0.92)',
  },
  tabLabel: {
    fontFamily: MusicFonts.semiBold,
    fontSize: 14,
    color: '#ffffff',
  },
  sectionTitle: {
    marginBottom: 12,
    fontFamily: MusicFonts.bold,
    fontSize: 17,
    color: MusicColors.cream,
  },
  statGrid: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 24,
  },
  statCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 16,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(221,189,134,0.3)',
  },
  statValue: {
    fontFamily: MusicFonts.bold,
    fontSize: 26,
    color: MusicColors.cream,
  },
  statLabel: {
    marginTop: 4,
    fontFamily: MusicFonts.medium,
    fontSize: 12,
    color: MusicColors.sand,
  },
  note: {
    fontFamily: MusicFonts.medium,
    fontSize: 12,
    lineHeight: 18,
    color: MusicColors.sand,
    opacity: 0.8,
  },
  empty: {
    fontFamily: MusicFonts.medium,
    fontSize: 14,
    color: '#ffffff',
    opacity: 0.87,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12,
    padding: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  cardFlagged: {
    borderColor: 'rgba(255, 138, 138, 0.4)',
    backgroundColor: 'rgba(255, 138, 138, 0.05)',
  },
  cardBody: {
    flex: 1,
    gap: 2,
  },
  cardTitle: {
    fontFamily: MusicFonts.semiBold,
    fontSize: 15,
    color: MusicColors.cream,
  },
  cardSub: {
    fontFamily: MusicFonts.medium,
    fontSize: 12,
    color: MusicColors.sand,
    opacity: 0.8,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  tag: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: 'rgba(221,189,134,0.2)',
    fontFamily: MusicFonts.medium,
    fontSize: 11,
    color: MusicColors.sand,
  },
  flag: {
    fontFamily: MusicFonts.semiBold,
    fontSize: 11,
    color: BAD,
  },
  artworkBox: {
    width: 54,
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#301815',
  },
  artwork: {
    width: '100%',
    height: '100%',
  },
  artworkFallback: {
    fontSize: 20,
  },
  action: {
    minWidth: 64,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  actionDanger: {
    backgroundColor: 'rgba(255,80,80,0.15)',
  },
  actionSafe: {
    backgroundColor: 'rgba(136,212,158,0.15)',
  },
  actionLabel: {
    fontFamily: MusicFonts.semiBold,
    fontSize: 12,
  },
  pager: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  pagerButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#ffffff',
    borderRadius: 40,
  },
  pagerDisabled: {
    opacity: 0.35,
  },
  pagerLabel: {
    fontFamily: MusicFonts.semiBold,
    fontSize: 13,
    color: '#ffffff',
  },
  pagerInfo: {
    fontFamily: MusicFonts.medium,
    fontSize: 12,
    color: MusicColors.sand,
    textAlign: 'center',
  },
  denied: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 30,
  },
  deniedText: {
    marginBottom: 20,
    fontFamily: MusicFonts.medium,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    color: MusicColors.sand,
  },
  primaryButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 24,
    backgroundColor: MusicColors.gold,
  },
  primaryButtonLabel: {
    fontFamily: MusicFonts.bold,
    fontSize: 14,
    color: MusicColors.brown,
  },
});
