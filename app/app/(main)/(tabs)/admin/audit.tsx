import React, { useState } from 'react';
import { FlatList, ScrollView, Text, View } from 'react-native';
import * as Sharing from 'expo-sharing';
import { api } from '../../../../src/api/client';
import { formatDay, formatTime, useI18n } from '../../../../src/i18n';
import { withTempPlainFile } from '../../../../src/media/files';
import { useSession } from '../../../../src/state/session';
import { useAsync } from '../../../../src/ui/useAsync';
import { Button, Chip, Muted, Screen, Title } from '../../../../src/ui/kit';
import { useTheme } from '../../../../src/ui/theme';

interface Entry { id: number; at: number; actorUserId: string | null; action: string; targetType: string | null; targetId: string | null; meta: Record<string, unknown> | null }

const FILTERS = ['', 'message', 'archive', 'file', 'group', 'user', 'device', 'otp', 'settings', 'security'];

/** Who viewed, sent, deleted, saved to the archive, disconnected a device… exportable to CSV (§4.6). */
export default function Audit() {
  const { t, locale, s } = useI18n();
  const th = useTheme();
  const { memberName } = useSession();
  const [action, setAction] = useState('');
  const { data, loading } = useAsync(() => api.get<{ entries: Entry[] }>(`/v1/admin/audit?limit=200${action ? `&action=${action}` : ''}`), [action]);
  const [busy, setBusy] = useState(false);

  const exportCsv = async () => {
    setBusy(true);
    try {
      const csv = await api.get<string>(`/v1/admin/audit.csv${action ? `?action=${action}` : ''}`);
      await withTempPlainFile('contexa-audit.csv', new TextEncoder().encode(csv), (uri) => Sharing.shareAsync(uri, { mimeType: 'text/csv' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ padding: 16, gap: 10 }}>
        <Title>{t('auditLog')}</Title>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {FILTERS.map((f) => <Chip key={f} label={f || t('filterAll')} active={action === f} onPress={() => setAction(f)} />)}
        </ScrollView>
        <Button variant="secondary" title={t('exportCsv')} onPress={exportCsv} loading={busy} />
      </View>
      <FlatList
        data={data?.entries ?? []}
        keyExtractor={(e) => String(e.id)}
        ListEmptyComponent={<Muted style={{ textAlign: 'center' }}>{loading ? t('loading') : t('noResults')}</Muted>}
        renderItem={({ item: e }) => (
          <View style={{ padding: 12, paddingHorizontal: 16, borderBottomWidth: 0.5, borderBottomColor: th.border, backgroundColor: th.surface }}>
            <Text style={{ color: th.text, fontWeight: '600', writingDirection: 'ltr' }}>{e.action}</Text>
            <Muted>{`${formatDay(e.at, locale, s)} ${formatTime(e.at, locale)} · ${e.actorUserId ? memberName(e.actorUserId) || e.actorUserId.slice(0, 6) : 'system'}${e.targetType ? ` · ${e.targetType}` : ''}`}</Muted>
            {e.meta ? <Muted style={{ writingDirection: 'ltr' }}>{JSON.stringify(e.meta)}</Muted> : null}
          </View>
        )}
      />
    </Screen>
  );
}
