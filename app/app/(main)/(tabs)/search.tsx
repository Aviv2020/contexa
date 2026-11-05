import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { GroupSummary } from '../../../src/api/types';
import type { LocalMessage } from '../../../src/db/local';
import { formatDay, useI18n } from '../../../src/i18n';
import { bus } from '../../../src/state/events';
import { useSession } from '../../../src/state/session';
import { Chip, Field, Muted, Screen } from '../../../src/ui/kit';
import { useTheme } from '../../../src/ui/theme';

/**
 * Message search runs on the device over the decrypted local database (§4.5) — the server cannot read content.
 * Only groups the user currently belongs to are present locally, so former groups never appear.
 */
export default function Search() {
  const params = useLocalSearchParams<{ groupId?: string }>();
  const { t, locale, s } = useI18n();
  const th = useTheme();
  const { engine, members, memberName } = useSession();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'image' | 'document' | null>(null);
  const [savedOnly, setSavedOnly] = useState(false);
  const [sender, setSender] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [results, setResults] = useState<LocalMessage[]>([]);
  const [groups, setGroups] = useState<Map<string, GroupSummary>>(new Map());
  const [syncedUntil, setSyncedUntil] = useState<number | null>(null);
  const [complete, setComplete] = useState(true);

  useEffect(() => {
    if (!engine) return;
    void engine.db.listGroups().then((g) => setGroups(new Map(g.map((x) => [x.id, x]))));
    const refreshMeta = async () => {
      setComplete((await engine.db.getMeta('historyComplete')) === '1');
      const u = await engine.db.getMeta('syncedUntil');
      setSyncedUntil(u ? Number(u) : null);
    };
    void refreshMeta();
    return bus.on('syncProgress', () => void refreshMeta());
  }, [engine]);

  const query = useMemo(() => ({
    text: q, kind: kind ?? undefined, savedOnly, senderId: sender ?? undefined, groupId: params.groupId,
    from: /^\d{4}-\d{2}-\d{2}$/.test(from) ? Date.parse(from) : undefined,
    to: /^\d{4}-\d{2}-\d{2}$/.test(to) ? Date.parse(to) + 86_399_999 : undefined,
  }), [q, kind, savedOnly, sender, from, to, params.groupId]);

  useEffect(() => {
    if (!engine) return;
    const active = query.text.trim() || query.kind || query.savedOnly || query.senderId || query.from || query.to;
    if (!active) return setResults([]);
    const h = setTimeout(() => void engine.db.search(query).then(setResults).catch(() => setResults([])), 200);
    return () => clearTimeout(h);
  }, [engine, query]);

  return (
    <Screen edges={['top']}>
      <View style={{ padding: 16, gap: 10 }}>
        <Field value={q} onChangeText={setQ} placeholder={t('searchPlaceholder')} autoFocus={!!params.groupId} returnKeyType="search" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          <Chip label={t('filterImages')} active={kind === 'image'} onPress={() => setKind(kind === 'image' ? null : 'image')} />
          <Chip label={t('filterDocs')} active={kind === 'document'} onPress={() => setKind(kind === 'document' ? null : 'document')} />
          <Chip label={t('filterSaved')} active={savedOnly} onPress={() => setSavedOnly(!savedOnly)} />
          {members.map((m) => <Chip key={m.id} label={`${t('fromSender')}: ${m.name}`} active={sender === m.id} onPress={() => setSender(sender === m.id ? null : m.id)} />)}
        </ScrollView>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}><Field placeholder={`${t('from')} YYYY-MM-DD`} value={from} onChangeText={setFrom} /></View>
          <View style={{ flex: 1 }}><Field placeholder={`${t('to')} YYYY-MM-DD`} value={to} onChangeText={setTo} /></View>
        </View>
        {!complete && syncedUntil ? <Muted>{t('searchIncludesUntil', { date: formatDay(syncedUntil, locale, s) })}</Muted> : null}
      </View>
      <FlatList
        data={results}
        keyExtractor={(m) => m.id}
        ListEmptyComponent={q ? <Muted style={{ textAlign: 'center', marginTop: 40 }}>{t('noResults')}</Muted> : undefined}
        renderItem={({ item: m }) => {
          const g = groups.get(m.groupId);
          return (
            <Pressable onPress={() => router.push({ pathname: '/(main)/group/[id]', params: { id: m.groupId } })} style={{ padding: 14, paddingHorizontal: 16, borderBottomWidth: 0.5, borderBottomColor: th.border, gap: 3, backgroundColor: th.surface }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontWeight: '700', color: th.text }}>{g ? `${g.name} ${g.displayId}` : ''}</Text>
                <Muted>{formatDay(m.createdAt, locale, s)}</Muted>
              </View>
              <Text style={{ color: th.text }} numberOfLines={2}>
                <Text style={{ color: th.accent }}>{memberName(m.senderId)}: </Text>
                {m.kind !== 'text' ? '📎 ' : ''}{m.payload?.text ?? m.payload?.files?.map((f) => f.name).join(', ')}
              </Text>
              {m.archive.length ? <Muted>✓ {m.archive[0].docTypeName}</Muted> : null}
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}
