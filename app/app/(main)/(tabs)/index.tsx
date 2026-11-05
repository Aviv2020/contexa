import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, Platform, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useI18n, formatListTime } from '../../../src/i18n';
import { useSession } from '../../../src/state/session';
import { bus } from '../../../src/state/events';
import { api } from '../../../src/api/client';
import type { GroupSummary } from '../../../src/api/types';
import { Avatar, Badge, Chip, Field, Muted, Screen } from '../../../src/ui/kit';
import { space, useTheme } from '../../../src/ui/theme';

type Filter = 'all' | 'unread' | 'pinned' | 'archived';

export default function Groups() {
  const { t, locale, s } = useI18n();
  const th = useTheme();
  const { engine, org, orgs, memberName } = useSession();
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [online, setOnline] = useState(true);

  const label = org?.contextType?.label ?? '';
  const canCreate = org?.mode === 'standalone' && (org.role === 'admin' || org.settings.permissions.usersCreateContexts);
  const otherUnread = orgs.filter((o) => o.id !== org?.org.id).reduce((n, o) => n + (o.unread ?? 0), 0);

  const load = useCallback(async () => {
    if (!engine) return;
    // Local-first: the cached list renders instantly (§6.2), the network refresh follows.
    if (!q && filter !== 'archived') setGroups(await engine.db.listGroups());
    try {
      const fresh = q || filter === 'archived' ? await engine.refreshGroups({ filter: filter === 'archived' ? 'archived' : 'all', q }) : await engine.refreshGroups();
      setGroups(fresh);
    } catch {
      /* offline: keep cache */
    }
  }, [engine, q, filter]);

  useEffect(() => {
    const h = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(h);
  }, [load, q]);
  useEffect(() => bus.on('groups', () => void load()), [load]);
  useEffect(() => bus.on('messages', () => void load()), [load]);
  useEffect(() => bus.on('connection', (e) => setOnline(e.online)), []);

  const visible = useMemo(() => {
    let list = groups;
    if (filter === 'unread') list = list.filter((g) => g.unread > 0);
    if (filter === 'pinned') list = list.filter((g) => g.pinned);
    return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivityAt - a.lastActivityAt);
  }, [groups, filter]);

  useEffect(() => {
    if (!engine) return;
    let alive = true;
    (async () => {
      const out: Record<string, string> = {};
      for (const g of visible.slice(0, 60)) {
        if (g.archivedAt) {
          out[g.id] = t('archivedGroup');
          continue;
        }
        const p = await engine.preview(g);
        if (p) {
          const who = p.senderId === engine.userId ? '' : memberName(p.senderId).split(' ')[0];
          const body = p.kind === 'text' ? p.text : `📎 ${p.text}`;
          out[g.id] = who ? `${who}: ${body}` : body;
        } else if (g.lastMessage?.deletedAt) out[g.id] = t('messageDeleted');
      }
      if (alive) setPreviews(out);
    })();
    return () => {
      alive = false;
    };
  }, [visible, engine, memberName, t]);

  const unreadCount = groups.filter((g) => g.unread > 0).length;

  const actions = (g: GroupSummary) => {
    const muted = g.mutedUntil === -1 || g.mutedUntil > Date.now();
    const opts = [g.pinned ? t('unpin') : t('pin'), ...(muted ? [t('unmute')] : [t('muteHour'), t('muteTomorrow'), t('muteForever')]), t('cancel')];
    const run = async (i: number) => {
      const tomorrow = new Date();
      tomorrow.setHours(24 + 8, 0, 0, 0);
      const body = i === 0 ? { pinned: !g.pinned } : muted ? { mutedUntil: 0 } : { mutedUntil: [Date.now() + 3600_000, tomorrow.getTime(), -1][i - 1] };
      if (i === opts.length - 1) return;
      await api.put(`/v1/groups/${g.id}/state`, body);
      await load();
    };
    if (Platform.OS === 'ios') ActionSheetIOS.showActionSheetWithOptions({ options: opts, cancelButtonIndex: opts.length - 1, title: g.name }, run);
    else Alert.alert(g.name, undefined, opts.map((o, i) => ({ text: o, onPress: () => run(i), style: i === opts.length - 1 ? 'cancel' : 'default' })));
  };

  return (
    <Screen edges={['top']}>
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm }}>
        <Pressable onPress={() => router.push('/(auth)/orgs')} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }} accessibilityLabel={t('switchOrg')}>
          <Text style={{ fontSize: 22, fontWeight: '700', color: th.text }}>{org?.org.name}</Text>
          <Text style={{ color: th.textMuted }}>▾</Text>
          <Badge n={otherUnread} />
        </Pressable>
        {!online ? <Muted>{t('offline')}</Muted> : null}
        <Field value={q} onChangeText={setQ} placeholder={t('searchGroups')} returnKeyType="search" clearButtonMode="while-editing" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 8 }}>
          <Chip label={t('filterAll')} active={filter === 'all'} onPress={() => setFilter('all')} />
          <Chip label={t('filterUnread')} active={filter === 'unread'} onPress={() => setFilter('unread')} count={unreadCount} />
          <Chip label={t('filterPinned')} active={filter === 'pinned'} onPress={() => setFilter('pinned')} />
          <Chip label={t('filterArchived')} active={filter === 'archived'} onPress={() => setFilter('archived')} />
          {/* Plugin-provided filters (e.g. "my patients today") arrive with the plugin platform in phase B. */}
        </ScrollView>
      </View>
      <FlatList
        data={visible}
        keyExtractor={(g) => g.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListEmptyComponent={<Muted style={{ textAlign: 'center', marginTop: 48 }}>{t('noGroups')}</Muted>}
        renderItem={({ item: g }) => (
          <Pressable
            onPress={() => router.push({ pathname: '/(main)/group/[id]', params: { id: g.id } })}
            onLongPress={() => actions(g)}
            style={({ pressed }) => ({ flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg, paddingVertical: 10, backgroundColor: pressed ? th.surfaceAlt : 'transparent', opacity: g.archivedAt ? 0.6 : 1 })}
          >
            <Avatar name={g.name} size={48} />
            <View style={{ flex: 1, gap: 3, borderBottomWidth: 0.5, borderBottomColor: th.border, paddingBottom: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={{ fontSize: 16, fontWeight: g.unread ? '700' : '600', color: th.text, flexShrink: 1 }} numberOfLines={1}>{g.name}</Text>
                {g.displayId ? <Text style={{ color: th.textMuted, fontSize: 13 }}>{g.displayId}</Text> : null}
                {g.pinned ? <Text style={{ fontSize: 12 }}>📌</Text> : null}
                {g.mutedUntil === -1 || g.mutedUntil > Date.now() ? <Text style={{ fontSize: 12 }}>🔕</Text> : null}
                <View style={{ flex: 1 }} />
                <Text style={{ color: g.unread ? th.accent : th.textMuted, fontSize: 12 }}>{formatListTime(g.lastActivityAt, locale, s)}</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={{ flex: 1, color: th.textMuted, fontSize: 14 }} numberOfLines={1}>{previews[g.id] ?? ''}</Text>
                <Badge n={g.unread} />
              </View>
            </View>
          </Pressable>
        )}
      />
      {canCreate ? (
        <Pressable
          onPress={() => router.push('/(main)/new-context')}
          accessibilityLabel={t('newContext', { label })}
          style={{ position: 'absolute', bottom: 20, end: 20, backgroundColor: th.brand, borderRadius: 28, paddingHorizontal: 20, height: 56, alignItems: 'center', justifyContent: 'center', elevation: 4 }}
        >
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>＋ {t('newContext', { label })}</Text>
        </Pressable>
      ) : null}
    </Screen>
  );
}
